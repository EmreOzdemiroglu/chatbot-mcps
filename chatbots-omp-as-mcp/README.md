# chatbots-omp-as-mcp

An MCP bridge that connects **ChatGPT** and **Grok** directly to the **full local Oh My Pi (OMP) agent** running on your computer.

```
ChatGPT/Grok ──HTTPS (trycloudflare.com)──► /mcp/<API_KEY> ──► cloudflared ──► localhost:7879/mcp
                                                                             (omp_prompt runner)
```

Unlike basic file-tool MCPs, this bridge exposes OMP's high-level capabilities, allowing the remote chatbot to delegate multi-step engineering tasks (e.g. running builds, debugging test suites, using local skills/models) to the local OMP agent.

---
### 1. Install & Start
```bash
git clone https://github.com/EmreOzdemiroglu/chatbot-mcps.git
cd chatbot-mcps/chatbots-omp-as-mcp
npm install

# Start the server (defaults to Port 7879 and utilizes your local OMP configuration)
npm start
```

If you installed the shell alias on your machine, you can start it from any workspace instead:
```bash
chatbots-omp
```

### 2. Configure Workspace (Optional)
```bash
MCP_ROOT=/path/to/my-project npm start
```

---

## Connecting to ChatGPT / Grok

### A. ChatGPT Setup (Web)
1. Open **Settings** → **Apps & Connectors** → **Advanced** → Turn **Developer mode** **ON**.
2. Click **Create** to add a new Connector.
3. Fill in:
   - **Name:** `Local OMP Agent`
   - **Server URL:** Copy the printed **Streamable HTTP (ChatGPT/Grok secure path)** from the startup log (looks like `https://<random>.trycloudflare.com/mcp/omp-mcp-<secret>`).
   - **Authentication:** Choose **No authentication** (secure because the key is in the URL path).
4. Check **I trust this provider** and click **Create**.
5. Enable the connector in a chat conversation and start using it.

### B. Grok Setup
1. Go to [grok.com/connectors](https://grok.com/connectors) → **New Connector** → **Custom**.
2. Paste the same secure path URL.
3. Set authentication to **No authentication**.

---

## Exposed Tools

| Tool | Purpose |
|------|---------|
| `omp_prompt` | Hand a complex task to the full OMP agent. Runs non-interactively with auto-approve. |
| `omp_continue` | Same as `omp_prompt` but continues the previous turn's session history. |
| `list_models` | Lists local OMP configs (roles, providers) and suggested `--model` overrides. |
| `omp_status` | Check OMP binary access, configurations, and allowed directories. |

### Selecting Models from ChatGPT
When invoking `omp_prompt`, ChatGPT can target any model configured in your OMP agent by passing the `model` argument:
- `omp_prompt(prompt: "Write tests", model: "gpt-5.5")`
- `omp_prompt(prompt: "Analyze codebase", model: "gemini-3.5-flash")`
- *Omitted model parameter defaults to your OMP `modelRoles.default` (e.g. Grok 4.5).*

---

## Configuration Variables

Copy `.env.example` to `.env` in the project root or edit `~/.chatbots-omp-as-mcp/.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7879` | Local port for the HTTP/SSE server |
| `MCP_ROOT` | `process.cwd()` | Allowed directory root for OMP sessions |
| `MCP_OMP_BIN` | `~/.local/bin/omp` | Path to the local `omp` executable |
| `MCP_OMP_TIMEOUT_SEC` | `600` | Max runtime limit per agent prompt (seconds) |
| `MCP_OMP_DEFAULT_MODEL` | `(omp default)` | Model to use if not specified |

---

## License
MIT
