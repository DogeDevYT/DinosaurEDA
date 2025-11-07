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

//route to our public directory to serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Create an HTTP server from our Express app
const server = http.createServer(app);

// Create a WebSocket server and attach it to the HTTP server
// The 'path' must match the frontend's WebSocket URL
const wss = new WebSocketServer({ server, path: '/compile' });

const PORT = 8080;
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
    // 1. Create a unique temporary directory on the HOST
    // This is safer than writing to a fixed path
    const tempId = crypto.randomBytes(16).toString('hex');
    const tempDir = path.join(__dirname, 'temp', tempId);
    await fs.mkdir(tempDir, { recursive: true });

    const codeFile = path.join(tempDir, 'design.v');
    const hostPath = tempDir; // The path on our server
    const containerPath = '/app'; // The path inside the Docker container

    try {
        // 2. Write the user's code to a file
        await fs.writeFile(codeFile, code);
        ws.send('--- Created temp file. Starting sandbox... ---\r\n');

        // 3. Define the Docker command
        // We will run Yosys with a simple synthesis command
        // This command:
        //   - 'docker run' : Starts a new container
        //   - '--rm' : Automatically deletes the container when it exits
        //   - '-v "..."' : Mounts our tempDir into the container's /app dir
        //   - '-w "..."' : Sets the working directory inside the container
        //   - DOCKER_IMAGE : 'yosys-compiler-img'
        //   - 'yosys' : The command to run
        //   - ...args : Arguments for Yosys
        const yosysCommand = 'yosys';
        const yosysArgs = [
            '-p', // Use a 'pass' script
            'read_verilog design.v; synth_ice40 -o build.bin; stat', // The script
            'design.v' // The file to run on
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

        // 4. Run the command using 'spawn'
        // 'spawn' streams stdout/stderr, which is perfect for a live terminal
        const compilerProcess = spawn('docker', dockerArgs);

        // 5. Stream STDOUT (Standard Output) to the client
        compilerProcess.stdout.on('data', (data) => {
            ws.send(data.toString());
        });

        // 6. Stream STDERR (Error Output) to the client
        // We send errors to the same terminal
        compilerProcess.stderr.on('data', (data) => {
            ws.send(data.toString());
        });

        // 7. Handle process exit
        compilerProcess.on('close', (code) => {
            ws.send(`\r\n--- Compilation finished (exit code ${code}) ---\r\n`);
            
            // 8. CRITICAL: Clean up the temp directory
            fs.rm(tempDir, { recursive: true, force: true })
                .catch(err => console.error('Failed to clean up temp dir:', err));
        });

        // 8. Handle spawn errors (e.g., "docker" command not found)
        compilerProcess.on('error', (err) => {
            ws.send(`\r\n--- FATAL: Failed to start compiler: ${err.message} ---\r\n`);
            fs.rm(tempDir, { recursive: true, force: true })
                .catch(err => console.error('Failed to clean up temp dir:', err));
        });

    } catch (err) {
        // Handle errors in file writing or directory creation
        ws.send(`\r\n--- Server-side error: ${err.message} ---\r\n`);
        // Clean up even if we fail
        await fs.rm(tempDir, { recursive: true, force: true })
             .catch(err => console.error('Failed to clean up temp dir:', err));
    }
}

// --- 5. Start Listening ---
server.listen(PORT, () => {
    console.log(`Backend server started on http://localhost:${PORT}`);
    console.log(`WebSocket server listening on ws://localhost:${PORT}/compile`);
});