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

// -- ANSI COLOR CODES --
const ANSI_BLUE = '\x1b[34m';
const ANSI_GREEN = '\x1b[32m'; 
const ANSI_RED = '\x1b[31m';   
const ANSI_RESET = '\x1b[0m';

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

// --- Helper to send non-log JSON ---
function sendJson(ws, data) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(data));
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
            } else if (data.type === 'generateDiagram' && data.code) {
                // --- NEW: Handle Diagram Generation ---
                await runDiagramGeneration(ws, data.code);
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
async function runInSandbox(ws, verilogCode) { 
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
        await fs.writeFile(codeFile, verilogCode); 

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

        // 3. The 'code' variable here is the exit code.
        compilerProcess.on('close', async (exitCode) => { 
            clearInterval(heartbeatInterval);
            
            if (exitCode === 0) {
                sendTerminalLog(ws, `\r\n${ANSI_GREEN}--- Compilation finished (exit code ${exitCode}) ---${ANSI_RESET}\r\n`);
            } else {
                sendTerminalLog(ws, `\r\n${ANSI_RED}--- Compilation finished (exit code ${exitCode}) ---${ANSI_RESET}\r\n`);
            }
            
            await getGeminiDescription(ws, fullOutput, exitCode, verilogCode); 

            fs.rm(tempDir, { recursive: true, force: true })
                .catch(err => console.error('Failed to clean up temp dir:', err));
        });

        compilerProcess.on('error', (err) => {
            clearInterval(heartbeatInterval);
            sendTerminalLog(ws, `\r\n${ANSI_RED}--- FATAL: Failed to start compiler: ${err.message} ---${ANSI_RESET}\r\n`);
            fs.rm(tempDir, { recursive: true, force: true })
                .catch(err => console.error('Failed to clean up temp dir:', err));
        });

    } catch (err) {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        sendTerminalLog(ws, `\r\n${ANSI_RED}--- FATAL Server-side error: ${err.message} ---${ANSI_RESET}\r\n`);
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true })
                 .catch(err => console.error('Failed to clean up temp dir:', err));
        }
    }
}

/**
 * --- 5. Gemini Explanation Function ---
 */
async function getGeminiDescription(ws, yosysOutput, exitCode, verilogCode) {
    try {
        sendTerminalLog(ws, '\r\n--- 🤖 Gemini is thinking... ---\r\n');

        const successString = (exitCode === 0) ? "succeeded" : "failed";
        
        // 2. Create a new, much more powerful prompt
        const prompt = `
            A user submitted the following Verilog code for synthesis:
            --- START VERILOG CODE ---
            ${verilogCode}
            --- END VERILOG CODE ---

            The Yosys synthesizer ran and the compilation ${successString} with exit code ${exitCode}.
            Here is the complete Yosys terminal log:
            --- START YOSYS LOG ---
            ${yosysOutput}
            --- END YOSYS LOG ---

            Please act as a helpful teaching assistant. Analyze BOTH the code and the log to provide a simple, beginner-friendly explanation.
            
            - If the compilation failed, look at the error message in the log (e.g., "ERROR: syntax error..."). Find the corresponding line in the Verilog code and explain *exactly* what the user did wrong and how to fix it.
            - If the compilation succeeded, briefly explain what the statistics in the log mean (e.g., "Number of cells: 22" means it created 22 logic gates).
            - Keep the explanation concise (2-4 paragraphs).
        `;

        const request = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        };
        
        const result = await model.generateContent(request);
        const text = result.response.candidates[0].content.parts[0].text;

        sendTerminalLog(ws, `\r\n${ANSI_BLUE}--- 🤖 Gemini's Explanation ---${ANSI_RESET}\r\n`);
        sendTerminalLog(ws, `${ANSI_BLUE}${text}${ANSI_RESET}`);
        sendTerminalLog(ws, `\r\n${ANSI_BLUE}--------------------------------${ANSI_RESET}\r\n`);

    } catch (error) {
        console.error("Gemini API Error (Description):", error);
        sendTerminalLog(ws, `\r\n${ANSI_BLUE}--- 🤖 Gemini Error: Could not get explanation. ---${ANSI_RESET}\r\n`);
    }
}

/**
 * --- 6. NEW: Gemini Verilog Generation Function ---
 */
async function getGeminiVerilog(ws, userPrompt) {
    try {
        // Send log to terminal so user sees activity
        sendTerminalLog(ws, `\r\n${ANSI_BLUE}--- 🤖 Gemini is generating Verilog code... ---${ANSI_RESET}\r\n`);

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
        sendTerminalLog(ws, `${ANSI_BLUE}--- 🤖 Verilog code generated successfully. ---${ANSI_RESET}\r\n`);

    } catch (error) {
        console.error("Gemini API Error (Generation):", error);
        sendTerminalLog(ws, `\r\n${ANSI_BLUE}--- 🤖 Gemini Error: Could not generate code. ---${ANSI_RESET}\r\n`);
    }
}

/**
 * --- 7. NEW: Diagram Generation Function ---
 * (Re-written to use netlistsvg for proper logic symbols)
 */
async function runDiagramGeneration(ws, verilogCode) {
    let tempDir = null;
    try {
        // 1. Create a temp directory
        const tempId = crypto.randomBytes(16).toString('hex');
        tempDir = path.join(__dirname, 'temp', tempId); 
        await fs.mkdir(tempDir, { recursive: true });
        
        const codeFile = path.join(tempDir, 'design.v');
        const jsonFile = path.join(tempDir, 'netlist.json'); // Yosys output
        const svgFile = path.join(tempDir, 'diagram.svg');  // netlistsvg output

        await fs.writeFile(codeFile, verilogCode);

        // 2. Define Yosys (Docker) command to create .json netlist
        const yosysCommand = 'yosys';
        const yosysArgs = [
            '-p', 
            // 1. Read, 2. Synth, 3. Write JSON netlist
            `read_verilog design.v; synth; write_json ${path.join('/app', 'netlist.json')}`
        ];
        const dockerArgs = [
            'run', '--rm', '-v', `${tempDir}:${'/app'}`,
            '-w', '/app', DOCKAER_IMAGE, yosysCommand, ...yosysArgs
        ];
        
        // 3. Run Yosys (Docker) process
        sendTerminalLog(ws, '--- 📊 [1/3] Synthesizing Verilog to JSON netlist... ---\r\n');
        const yosysProcess = spawn('docker', dockerArgs);
        yosysProcess.stdin.end();

        // Pipe Yosys output to terminal for debugging
        yosysProcess.stdout.on('data', (data) => sendTerminalLog(ws, data.toString()));
        yosysProcess.stderr.on('data', (data) => sendTerminalLog(ws, data.toString()));

        yosysProcess.on('close', async (yosysCode) => {
            if (yosysCode !== 0) {
                sendTerminalLog(ws, `\r\n${ANSI_RED}--- 📊 [ERROR] Yosys failed. Cannot generate diagram. ---${ANSI_RESET}\r\n`);
                return;
            }
            sendTerminalLog(ws, `\r\n${ANSI_GREEN}--- 📊 [1/3] Synthesis complete. ---${ANSI_RESET}\r\n`);
            
            // 4. Run netlistsvg command on the host VM
            sendTerminalLog(ws, '--- 📊 [2/3] Rendering schematic with netlistsvg... ---\r\n');
            const netlistProcess = spawn('netlistsvg', [jsonFile, '-o', svgFile]);
            
            // Handle errors from netlistsvg
            let netlistError = "";
            netlistProcess.stderr.on('data', (data) => {
                netlistError += data.toString();
            });

            netlistProcess.on('close', async (netlistCode) => {
                if (netlistCode !== 0) {
                    sendTerminalLog(ws, `\r\n${ANSI_RED}--- 📊 [ERROR] netlistsvg failed: ${netlistError} ---${ANSI_RESET}\r\n`);
                    return;
                }
                
                // 5. Read the SVG file and convert to Base64
                sendTerminalLog(ws, '--- 📊 [3/3] Sending SVG to browser... ---\r\n');
                const svgBuffer = await fs.readFile(svgFile);
                const base64Svg = svgBuffer.toString('base64');
                const dataUri = `data:image/svg+xml;base64,${base64Svg}`;

                // 6. Send the data URI to the frontend
                sendJson(ws, { type: 'diagramResult', svgDataUri: dataUri });
                
                // 7. Clean up
                fs.rm(tempDir, { recursive: true, force: true });
            });
            
            netlistProcess.on('error', (err) => {
                sendTerminalLog(ws, `\r\n${ANSI_RED}--- 📊 [ERROR] Failed to run netlistsvg. Is it installed? (sudo npm install -g netlistsvg) ---${ANSI_RESET}\r\n`);
            });
        });
        
        yosysProcess.on('error', (err) => {
            sendTerminalLog(ws, `\r\n${ANSI_RED}--- 📊 [ERROR] Failed to start Yosys (Docker). ---${ANSI_RESET}\r\n`);
        });

    } catch (err) {
        sendTerminalLog(ws, `\r\n${ANSI_RED}--- 📊 [FATAL] Diagram generation error: ${err.message} ---${ANSI_RESET}\r\n`);
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    }
}

// --- 8. Start Listening ---
server.listen(PORT, () => {
    console.log(`Backend server started on http://localhost:${PORT}`);
    console.log(`WebSocket server listening on ws://localhost:${PORT}/compile`);
});