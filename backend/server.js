// --- 1. Import Required Modules ---
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
// --- GEMINI: Import the Google AI SDK ---
const { GoogleGenerativeAI } = require('@google/generative-ai');


// --- 2. Setup Server ---
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/compile' });

const PORT = 8080;
const DOCKER_IMAGE = 'yosys-compiler-img';

// --- GEMINI: Initialize the API Client ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });


// --- 3. WebSocket Connection Logic ---
wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.send('--- Welcome! Connected to compiler backend. ---\r\n');

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.code) {
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
 */
async function runInSandbox(ws, code) {
    let heartbeatInterval = null;
    let tempDir = null;
    // --- GEMINI: Create a buffer to store all output ---
    let fullOutput = "";

    try {
        heartbeatInterval = setInterval(() => {
            if (ws.readyState === ws.OPEN) {
                ws.send("...working...\r\n");
            }
        }, 2000);
        ws.send('--- DEBUG: runInSandbox started. ---\r\n');

        const tempId = crypto.randomBytes(16).toString('hex');
        tempDir = path.join(__dirname, 'temp', tempId); 
        await fs.mkdir(tempDir, { recursive: true });
        ws.send(`--- DEBUG: tempDir created. ---\r\n`);

        const codeFile = path.join(tempDir, 'design.v');
        const hostPath = tempDir;
        const containerPath = '/app';

        await fs.writeFile(codeFile, code);
        ws.send('--- DEBUG: Code file written. ---\r\n');

        const yosysCommand = 'yosys';
        const yosysArgs = [
            '-p',
            'read_verilog design.v; synth_ice40; write_blif build.blif; stat'
        ];
        const dockerArgs = [
            'run', '--rm', '-v', `${hostPath}:${containerPath}`,
            '-w', containerPath, DOCKER_IMAGE, yosysCommand, ...yosysArgs
        ];
        ws.send('--- DEBUG: Docker command prepared. Spawning process... ---\r\n');

        const compilerProcess = spawn('docker', dockerArgs);
        compilerProcess.stdin.end();

        // --- GEMINI: Stream output to user AND save to buffer ---
        compilerProcess.stdout.on('data', (data) => {
            ws.send(data.toString());
            fullOutput += data.toString(); // Save to buffer
        });
        compilerProcess.stderr.on('data', (data) => {
            ws.send(data.toString());
            fullOutput += data.toString(); // Save to buffer
        });

        // --- GEMINI: Make this function 'async' to use 'await' ---
        compilerProcess.on('close', async (code) => {
            clearInterval(heartbeatInterval);
            ws.send(`\r\n--- Compilation finished (exit code ${code}) ---\r\n`);
            
            // --- GEMINI: Call our new function to get the explanation ---
            await getGeminiDescription(ws, fullOutput, code);

            fs.rm(tempDir, { recursive: true, force: true })
                .catch(err => console.error('Failed to clean up temp dir:', err));
        });

        compilerProcess.on('error', (err) => {
            clearInterval(heartbeatInterval);
            ws.send(`\r\n--- FATAL: Failed to start compiler: ${err.message} ---\r\n`);
            fs.rm(tempDir, { recursive: true, force: true })
                .catch(err => console.error('Failed to clean up temp dir:', err));
        });

    } catch (err) {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        ws.send(`\r\n--- FATAL Server-side error: ${err.message} ---\r\n`);
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true })
                 .catch(err => console.error('Failed to clean up temp dir:', err));
        }
    }
}

/**
 * --- 5. NEW: Gemini Explanation Function ---
 * This function takes the Yosys output and gets a Gemini explanation.
 */
async function getGeminiDescription(ws, yosysOutput, exitCode) {
    try {
        ws.send('\r\n--- 🤖 Gemini is thinking... ---\r\n');

        // Create a strong prompt for Gemini
        const successString = (exitCode === 0) ? "succeeded" : "failed";
        const prompt = `
            The following is a terminal log from the Yosys Verilog synthesizer. The compilation ${successString} with exit code ${exitCode}.
            Please analyze this log and provide a simple, beginner-friendly explanation of what happened.
            
            - What did the synthesizer do?
            - Were there any important warnings or errors (like syntax errors or undeclared variables)?
            - What was the result (e.g., did it print statistics about the synthesized design)?
            - Keep the explanation concise (2-4 paragraphs).

            Here is the log:
            ---
            ${yosysOutput}
            ---
        `;

        // Call the API
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        // Send the explanation
        ws.send('\r\n--- 🤖 Gemini\'s Explanation ---\r\n');
        ws.send(text);
        ws.send('\r\n--------------------------------\r\n');

    } catch (error) {
        console.error("Gemini API Error:", error);
        ws.send('\r\n--- 🤖 Gemini Error: Could not get explanation. ---\r\n');
    }
}

// --- 6. Start Listening ---
server.listen(PORT, () => {
    console.log(`Backend server started on http://localhost:${PORT}`);
    console.log(`WebSocket server listening on ws://localhost:${PORT}/compile`);
});