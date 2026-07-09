# chatbots-editreadmcp

A lightweight, secure Model Context Protocol (MCP) server that exposes a sandboxed coding-agent toolset (`bash`, `read_file`, `write_file`, `edit_file`, `search`) to **ChatGPT** and **Grok** custom connectors.

```
ChatGPT/Grok ──HTTPS (trycloudflare.com)──► /mcp/<API_KEY> ──► cloudflared ──► localhost:7878/mcp
                                                                             (Coding Tools)
```

## Features
- **Zero-Install Cloudflare Tunnel:** Automatically downloads and runs `cloudflared` to expose the local server on a public HTTPS URL.
- **Secure Path-Key Authentication:** Embeds the API key directly in the URL path (`/mcp/<key>`), letting you connect using **No authentication** in ChatGPT/Grok UI while maintaining strict private access.
- **Ripgrep-Accelerated Search:** Automatically uses `ripgrep` (`rg`) if available on your machine for ultra-fast code searches. Falls back to a native JS search that handles brace-expansion globs (e.g. `*.{go,ts,tsx}`).
- **Sandboxed Workspace:** Restricts all file reads, writes, and edits to the configured `MCP_ROOT` directory.

---
### 1. Install & Start
```bash
git clone https://github.com/EmreOzdemiroglu/chatbot-mcps.git
cd chatbot-mcps/chatbots-editreadmcp
npm install

# Start the server (defaults to Port 7878 and targets your current directory as the workspace)
npm start
```

If you installed the shell alias on your machine, you can start it from any workspace instead:
```bash
chatbots-editread
```

### 2. Configure Your Workspace (Optional)
By default, the server sandboxes file tools to the directory it was started in. To target a different project:
```bash
MCP_ROOT=/path/to/my-project npm start
```

---

## Connecting to ChatGPT / Grok

### A. ChatGPT Setup (Web)
1. Open **Settings** → **Apps & Connectors** → **Advanced** → Turn **Developer mode** **ON**.
2. Click **Create** to add a new Connector.
3. Fill in:
   - **Name:** `Local Coding Tools`
   - **Server URL:** Copy the printed **Streamable HTTP (ChatGPT/Grok secure path)** from the startup log (looks like `https://<random>.trycloudflare.com/mcp/editread-<secret>`).
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
| `read_file` | Read text files. Supports `offset` and `limit` line paging. |
| `write_file` | Create or overwrite a text file. Creates parent directories. |
| `edit_file` | Precise search-and-replace using exact string matches. |
| `search` | Recursive substring text search (uses `ripgrep` if present). |
| `bash` | Run shell commands inside the workspace root. |

---

## Configuration Variables

Copy `.env.example` to `.env` in the project root or edit `~/.chatbots-editreadmcp/.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7878` | Local port for the HTTP/SSE server |
| `MCP_ROOT` | `process.cwd()` | Directory the server is allowed to read/write |
| `MCP_NO_AUTH` | `0` | Disables API key check (dangerous) |
| `MCP_NO_TUNNEL` | `0` | Runs locally only (disables cloudflared) |

---

## License
MIT
