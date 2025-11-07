// --- 1. Import Required Modules ---
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process'); // To run commands
const fs = require('fs/promises'); // To write temp files
const path = require('path');
const crypto = require('crypto'); // To create unique IDs

// --- 2. Setup Server ---
const app = express();

// --- FIX: Serve static files from the '../public' directory ---
// This tells Express to send index.html when someone visits '/'
app.use(express.static(path.join(__dirname, '..', 'public')));

// Create an HTTP server from our Express app
const server = http.createServer(app);

// Create a WebSocket server and attach it to the HTTP server
// The 'path' must match the frontend's WebSocket URL
const wss = new WebSocketServer({ server, path: '/compile' });

const PORT = 8080;
// Use the pre-built Yosys image name
const DOCKER_IMAGE = 'yosys-compiler-img'; 

// --- 3. WebSocket Connection Logic ---
wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.send('--- Welcome! Connected to compiler backend. ---\r\n');

    // This is the main listener for 'Run' clicks
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.code) {
                // We received code, let's compile it
                await runInSandbox(ws, data.code);
            }
        } catch (e) {
            console.error('Failed to parse message or compile:', e);
            ws.send(`\r\n--- ERROR: ${e.message} ---\r\n`);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });
});

/**
 * --- 4. The Secure Sandbox Function ---
 * This function handles the entire Docker workflow.
 * @param {WebSocket} ws - The client's WebSocket to send output to.
 * @param {string} code - The Verilog code from the user.
 */
async function runInSandbox(ws, code) {
    let heartbeatInterval = null; // To hold our "compiling..." timer
    let tempDir = null;           // <-- FIX: Declare tempDir outside the try block

    try {
        // --- FIX: Start heartbeat IMMEDIATELY ---
        heartbeatInterval = setInterval(() => {
            if (ws.readyState === ws.OPEN) {
                ws.send("...working...\r\n"); // We'll see this right away
            }
        }, 2000);
        ws.send('--- DEBUG: runInSandbox started. ---\r\n');

        // 1. Create a unique temporary directory on the HOST
        const tempId = crypto.randomBytes(16).toString('hex');
        
        // --- FIX: Assign tempDir (remove 'const') ---
        tempDir = path.join(__dirname, 'temp', tempId); 
        await fs.mkdir(tempDir, { recursive: true });
        ws.send(`--- DEBUG: tempDir created. ---\r\n`);

        const codeFile = path.join(tempDir, 'design.v');
        const hostPath = tempDir; // The path on our server
        const containerPath = '/app'; // The path inside the Docker container

        // 2. Write the user's code to a file
        await fs.writeFile(codeFile, code);
        ws.send('--- DEBUG: Code file written. ---\r\n');

        // 3. Define the Docker command
        const yosysCommand = 'yosys';
        const yosysArgs = [
            '-p', // Use a 'pass' script
            'read_verilog design.v; synth_ice40 -o build.bin; stat' // The script
        ];
        const dockerArgs = [
            'run',
            '--rm',
            '-v', `${hostPath}:${containerPath}`,
            '-w', containerPath,
            DOCKER_IMAGE,
            yosysCommand,
            ...yosysArgs
        ];
        ws.send('--- DEBUG: Docker command prepared. Spawning process... ---\r\n');


        // 4. Run the command using 'spawn'
        const compilerProcess = spawn('docker', dockerArgs);

        //END STDIN input so yosys doesn't hang hopefully
        compilerProcess.stdin.end();

        // 5. Stream STDOUT (Standard Output) to the client
        compilerProcess.stdout.on('data', (data) => {
            ws.send(data.toString());
        });

        // 6. Stream STDERR (Error Output) to the client
        compilerProcess.stderr.on('data', (data) => {
            ws.send(data.toString());
        });

        // 7. Handle process exit
        compilerProcess.on('close', (code) => {
            clearInterval(heartbeatInterval); // Stop the heartbeat
            ws.send(`\r\n--- Compilation finished (exit code ${code}) ---\r\n`);
            
            // 8. CRITICAL: Clean up the temp directory
            fs.rm(tempDir, { recursive: true, force: true })
                .catch(err => console.error('Failed to clean up temp dir:', err));
        });

        // 8. Handle spawn errors (e.g., "docker" command not found)
        compilerProcess.on('error', (err) => {
            clearInterval(heartbeatInterval); // Stop the heartbeat
            ws.send(`\r\n--- FATAL: Failed to start compiler: ${err.message} ---\r\n`);
            fs.rm(tempDir, { recursive: true, force: true })
                .catch(err => console.error('Failed to clean up temp dir:', err));
        });

    } catch (err) {
        // --- FIX: This block is now safe ---
        if (heartbeatInterval) clearInterval(heartbeatInterval); // Stop heartbeat on error
        ws.send(`\r\n--- FATAL Server-side error: ${err.message} ---\r\n`);
        
        // Only try to clean up if tempDir was successfully created
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true })
                 .catch(err => console.error('Failed to clean up temp dir:', err));
        }
    }
}

// --- 5. Start Listening ---
server.listen(PORT, () => {
    console.log(`Backend server started on http://localhost:${PORT}`);
    console.log(`WebSocket server listening on ws://localhost:${PORT}/compile`);
});