# DinosaurEDA 🦕

A Cloud-Native, AI-Augmented Verilog IDE in your browser.

DinosaurEDA is a browser-based Integrated Development Environment (IDE) designed to democratize access to digital logic design. It eliminates the friction of complex toolchains by providing an instant, zero-setup environment for writing, synthesizing, and visualizing Verilog code.

## 🌟 Key Features

Instant Synthesis: Compile Verilog instantly using the open-source Yosys synthesizer running in a secure, sandboxed backend.

### AI-Powered Feedback: Get intelligent explanations for compiler errors and synthesis results powered by Google Vertex AI (Gemini 2.5 Flash).

### Generative Coding: Describe circuits in plain English, and let the AI generate the Verilog code for you.

### Automated Visualization: Convert your code into accurate, interactive SVG circuit diagrams with real logic symbols (Flip-Flops, LUTs, Gates).

### Professional Editor: Write code in a modern Monaco Editor with syntax highlighting and a real-time Xterm.js terminal.

### Secure & Sandboxed: All code runs in ephemeral Docker containers, ensuring total isolation and security.

## 🚀 How It Works

### DinosaurEDA uses a distributed architecture to bring hardware tools to the web:

### Frontend: A static HTML/JS client (hosted on the VM) connects to the backend via WebSockets.

### Backend: A Node.js server manages connections and orchestrates the compilation process.

### Execution: When you run code, the backend spins up a fresh Docker container with Yosys pre-installed.

### Streaming: The compiler's raw stdout and stderr are streamed in real-time to the web terminal.

### AI Analysis: The backend sends the code and logs to Google Vertex AI to generate helpful, context-aware explanations.

### Visualization: The backend uses yosys and netlistsvg to generate SVG diagrams, which are sent back to the client for display.

## 🛠️ Architecture & Tech Stack

### Frontend: HTML5, CSS3, JavaScript, Monaco Editor, Xterm.js

### Backend: Node.js, Express, ws (WebSockets)

### Synthesis: Yosys Open Synthesis Suite

### Visualization: Graphviz, netlistsvg

### AI Model: Google Vertex AI (Gemini 1.5 Flash)

### Infrastructure: Google Compute Engine (GCE), Docker, Cloudflare Tunnel

## 📦 Installation (Self-Hosting)

DinosaurEDA is designed to run on a Linux environment (like a GCE VM).

### Prerequisites

Node.js (v18+)

Docker (installed and running)

Graphviz (sudo apt-get install graphviz)

netlistsvg (sudo npm install -g netlistsvg)

Google Cloud Project with Vertex AI API enabled

### Setup

Clone the repository:

`git clone` [https://github.com/yourusername/DinosaurEDA.git](https://github.com/yourusername/DinosaurEDA.git)
and then
`cd DinosaurEDA/backend`


Build the Docker image:

`docker build -t yosys-compiler-img .`


Install dependencies:

`npm install`


Configure Server:
Edit `server.js` to add your Google Cloud Project ID and Region.

Run the server:

# Direct run
`node server.js`

# Or with PM2 (Recommended)
`pm2 start server.js --name "hdl-ide"`


Access:
Open `http://localhost:8080` (or set up a Cloudflare Tunnel for public access).

🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

Built with ❤️ by Raghav Vikramprabhu
