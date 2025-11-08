// --- 1. Import Required Modules ---
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { VertexAI } = require('@google-cloud/vertexai');

// --- 2. Setup Server ---
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/compile' });

const PORT = 8080;
const DOCKER_IMAGE = 'yosys-compiler-img';

// --- GEMINI: Initialize Vertex AI ---
const vertex_ai = new VertexAI({
  project: 'dinosaureda', // !! Replace with your Project ID
  location: 'us-east1', // !! Replace with your VM's region (e.g., 'us-east1')
});
const model = vertex_ai.getGenerativeModel({
    model: 'gemini-2.5-flash',
});

// --- RATE LIMIT: In-memory store ---
const clients = new Map();
const RATE_LIMIT_WINDOW_MS = 1 * 60 * 1000; 
const MAX_REQUESTS_PER_WINDOW = 10; 

// --- REFACTOR: Helper function to send terminal logs ---
function sendTerminalLog(ws, message) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'terminalLog', message: message }));
    }
}

// --- 3. WebSocket Connection Logic ---
wss.on('connection', (ws, req) => {
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
    ws.ip = ip; 
    console.log(`Client connected from IP: ${ip}`);
    sendTerminalLog(ws, '--- Welcome! Connected to compiler backend. ---\r\n');

    ws.on('message', async (message) => {
        try {
            // --- RATE LIMIT: Check ---
            const ip = ws.ip;
            if (!ip) {
                sendTerminalLog(ws, '--- ERROR: Could not identify your IP. ---\r\n');
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
                sendTerminalLog(ws, '--- ERROR: Too many requests. Please wait 1 minute. ---\r\n');
                return;
            }

            // --- REFACTOR: Handle different message types ---
            const data = JSON.parse(message.toString());
            
            if (data.type === 'compile' && data.code) {
                // User clicked "Run Synthesis"
                await runInSandbox(ws, data.code);
            } else if (data.type === 'generate' && data.prompt) {
                // User clicked "Generate Verilog"
                await getGeminiVerilog(ws, data.prompt);
            }
            
        } catch (e) {
            console.error('Failed to parse message or execute:', e);
            sendTerminalLog(ws, `\r\n--- ERROR: ${e.message} ---\r\n`);
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
            sendTerminalLog(ws, "...working...\r\n");
        }, 2000);
        
        const tempId = crypto.randomBytes(16).toString('hex');
        tempDir = path.join(__dirname, 'temp', tempId); 
        await fs.mkdir(tempDir, { recursive: true });

        const codeFile = path.join(tempDir, 'design.v');
        await fs.writeFile(codeFile, code);

        const yosysCommand = 'yosys';
        const yosysArgs = [
            '-p', 'read_verilog design.v; synth_ice40; write_blif build.blif; stat'
        ];
        const dockerArgs = [
            'run', '--rm', '-v', `${tempDir}:${'/app'}`,
            '-w', '/app', DOCKER_IMAGE, yosysCommand, ...yosysArgs
        ];

        const compilerProcess = spawn('docker', dockerArgs);
        compilerProcess.stdin.end();

        compilerProcess.stdout.on('data', (data) => {
            sendTerminalLog(ws, data.toString());
            fullOutput += data.toString();
        });
        compilerProcess.stderr.on('data', (data) => {
            sendTerminalLog(ws, data.toString());
            fullOutput += data.toString();
        });

        compilerProcess.on('close', async (code) => {
            clearInterval(heartbeatInterval);
            sendTerminalLog(ws, `\r\n--- Compilation finished (exit code ${code}) ---\r\n`);
            await getGeminiDescription(ws, fullOutput, code); // Explain the output
            fs.rm(tempDir, { recursive: true, force: true })
                .catch(err => console.error('Failed to clean up temp dir:', err));
        });

        compilerProcess.on('error', (err) => {
            clearInterval(heartbeatInterval);
            sendTerminalLog(ws, `\r\n--- FATAL: Failed to start compiler: ${err.message} ---\r\n`);
            fs.rm(tempDir, { recursive: true, force: true })
                .catch(err => console.error('Failed to clean up temp dir:', err));
        });

    } catch (err) {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        sendTerminalLog(ws, `\r\n--- FATAL Server-side error: ${err.message} ---\r\n`);
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true })
                 .catch(err => console.error('Failed to clean up temp dir:', err));
        }
    }
}

/**
 * --- 5. Gemini Explanation Function (Unchanged) ---
 */
async function getGeminiDescription(ws, yosysOutput, exitCode) {
    try {
        sendTerminalLog(ws, '\r\n--- 🤖 Gemini is thinking... ---\r\n');
        const successString = (exitCode === 0) ? "succeeded" : "failed";
        const prompt = `... (your existing explanation prompt) ...`; // Kept short for brevity
        const request = { contents: [{ role: 'user', parts: [{ text: prompt }] }], };
        const result = await model.generateContent(request);
        const text = result.response.candidates[0].content.parts[0].text;
        sendTerminalLog(ws, '\r\n--- 🤖 Gemini\'s Explanation ---\r\n');
        sendTerminalLog(ws, text);
        sendTerminalLog(ws, '\r\n--------------------------------\r\n');
    } catch (error) {
        console.error("Gemini API Error (Description):", error);
        sendTerminalLog(ws, '\r\n--- 🤖 Gemini Error: Could not get explanation. ---\r\n');
    }
}

/**
 * --- 6. NEW: Gemini Verilog Generation Function ---
 */
async function getGeminiVerilog(ws, userPrompt) {
    try {
        // Send log to terminal so user sees activity
        sendTerminalLog(ws, '\r\n--- 🤖 Gemini is generating Verilog code... ---\r\n');

        // Create a strong prompt for Verilog generation
        const prompt = `
            You are an expert Verilog code generator.
            A user wants a circuit that matches the following description.
            Provide only the complete, syntactically correct Verilog code block.
            Do not include any explanation, markdown, or "Here is the code:" text.
            Start the code with \`default_nettype none.
            
            User Description:
            "${userPrompt}"
        `;

        const request = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        };
        
        const result = await model.generateContent(request);
        const response = result.response;
        let code = response.candidates[0].content.parts[0].text;
        
        // Clean up Gemini's response (remove markdown backticks)
        code = code.replace(/```verilog/g, "").replace(/```/g, "").trim();

        // Send the code back to the client in the new format
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'generationResult', code: code }));
        }
        sendTerminalLog(ws, '--- 🤖 Verilog code generated successfully. ---\r\n');

    } catch (error) {
        console.error("Gemini API Error (Generation):", error);
        sendTerminalLog(ws, '\r\n--- 🤖 Gemini Error: Could not generate code. ---\r\n');
    }
}

// --- 7. Start Listening ---
server.listen(PORT, () => {
    console.log(`Backend server started on http://localhost:${PORT}`);
    console.log(`WebSocket server listening on ws://localhost:${PORT}/compile`);
});