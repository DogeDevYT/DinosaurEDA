// --- 1. Import Required Modules ---
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
// --- GEMINI: Import the *Vertex AI* SDK ---
const { VertexAI } = require('@google-cloud/vertexai');

// --- 2. Setup Server ---
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/compile' });

const PORT = 8080;
const DOCKER_IMAGE = 'yosys-compiler-img';

// --- GEMINI: Initialize Vertex AI ---
// !! Replace YOUR_PROJECT_ID_HERE with your GCloud Project ID !!
// !! Replace us-central1 with the region your VM is in !!
const vertex_ai = new VertexAI({
  project: 'dinosaureda',
  location: 'us-east1',
});
const model = vertex_ai.getGenerativeModel({
    model: 'gemini-2.5-flash',
});

// --- RATE LIMIT: In-memory store ---
const clients = new Map();
const RATE_LIMIT_WINDOW_MS = 1 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10;

// --- 3. WebSocket Connection Logic ---
wss.on('connection', (ws, req) => {
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
    ws.ip = ip;
    console.log(`Client connected from IP: ${ip}`);
    ws.send('--- Welcome! Connected to compiler backend. ---\r\n');

    ws.on('message', async (message) => {
        try {
            // --- RATE LIMIT: Check ---
            const ip = ws.ip;
            if (!ip) {
                ws.send('--- ERROR: Could not identify your IP. ---\r\n');
                return;
            }
            let record = clients.get(ip);
            if (!record) {
                record = { count: 1 };
                clients.set(ip, record);
                setTimeout(() => { clients.delete(ip); }, RATE_LIMIT_WINDOW_MS);
            } else {
                record.count++;
            }
            if (record.count > MAX_REQUESTS_PER_WINDOW) {
                console.warn(`Rate limit exceeded for IP: ${ip}`);
                ws.send('--- ERROR: Too many compile requests. ---\r\n');
                ws.send('Please wait 1 minute and try again.\r\n');
                return;
            }
            const data = JSON.parse(message.toString());
            if (data.code) {
                await runInSandbox(ws, data.code);
            }
        } catch (e) {
            console.error('Failed to parse message or compile:', e);
            ws.send(`\r\n--- ERROR: ${e.message} ---\r\n`);
        }
    });

    ws.on('close', () => console.log(`Client disconnected from IP: ${ws.ip}`));
    ws.on('error', (err) => console.error('WebSocket error:', err));
});

/**
 * --- 4. The Secure Sandbox Function ---
 */
async function runInSandbox(ws, code) {
    let heartbeatInterval = null;
    let tempDir = null;
    let fullOutput = "";

    try {
        heartbeatInterval = setInterval(() => {
            if (ws.readyState === ws.OPEN) {
                ws.send("...working...\r\n");
            }
        }, 2000);

        const tempId = crypto.randomBytes(16).toString('hex');
        tempDir = path.join(__dirname, 'temp', tempId);
        await fs.mkdir(tempDir, { recursive: true });

        const codeFile = path.join(tempDir, 'design.v');
        const hostPath = tempDir;
        const containerPath = '/app';

        await fs.writeFile(codeFile, code);

        const yosysCommand = 'yosys';
        const yosysArgs = [
            '-p',
            'read_verilog design.v; synth_ice40; write_blif build.blif; stat'
        ];
        const dockerArgs = [
            'run', '--rm', '-v', `${hostPath}:${containerPath}`,
            '-w', containerPath, DOCKER_IMAGE, yosysCommand, ...yosysArgs
        ];

        const compilerProcess = spawn('docker', dockerArgs);
        compilerProcess.stdin.end();

        compilerProcess.stdout.on('data', (data) => {
            ws.send(data.toString());
            fullOutput += data.toString();
        });
        compilerProcess.stderr.on('data', (data) => {
            ws.send(data.toString());
            fullOutput += data.toString();
        });

        compilerProcess.on('close', async (code) => {
            clearInterval(heartbeatInterval);
            ws.send(`\r\n--- Compilation finished (exit code ${code}) ---\r\n`);
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
 * --- 5. GEMINI: Updated Explanation Function ---
 */
async function getGeminiDescription(ws, yosysOutput, exitCode) {
    try {
        ws.send('\r\n--- 🤖 Gemini is thinking... ---\r\n');

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

        const request = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        };

        const result = await model.generateContent(request);
        const response = result.response;
        // This is how you safely get the text from a Vertex AI response
        const text = response.candidates[0].content.parts[0].text;

        ws.send('\r\n--- 🤖 Gemin\'s Explanation ---\r\n');
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