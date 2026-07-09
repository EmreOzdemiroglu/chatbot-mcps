# chatbot-mcps

Two local MCP servers for connecting **ChatGPT** and **Grok** to tools running on your own computer through Cloudflare free tunnels.

This repo contains two independent servers:

| Project | Port | Purpose |
|---------|------|---------|
| [`chatbots-editreadmcp`](./chatbots-editreadmcp) | `7878` | Lightweight coding-tool MCP: `read_file`, `write_file`, `edit_file`, `search`, `bash`. |
| [`chatbots-omp-as-mcp`](./chatbots-omp-as-mcp) | `7879` | Bridge to the full local Oh My Pi agent: `omp_prompt`, `omp_continue`, `list_models`, `omp_status`. |

Use them as **separate connectors**. The edit/read MCP is for direct coding-agent file and shell operations. The OMP MCP is for delegating larger multi-step work to the local Oh My Pi agent.

---

## Quick Start

Clone the repo:

```bash
git clone https://github.com/EmreOzdemiroglu/chatbot-mcps.git
cd chatbot-mcps
```

Install each server:

```bash
cd chatbots-editreadmcp
npm install
cd ../chatbots-omp-as-mcp
npm install
```

Start each server in a separate terminal:

```bash
# Terminal 1: coding tools, port 7878
cd chatbot-mcps/chatbots-editreadmcp
npm start
```

```bash
# Terminal 2: local OMP bridge, port 7879
cd chatbot-mcps/chatbots-omp-as-mcp
npm start
```

Each server prints a Cloudflare URL like:

```text
https://<random>.trycloudflare.com/mcp/<API_KEY>
```

Paste that URL into ChatGPT or Grok as a custom MCP connector and choose **No authentication**. The API key is already embedded in the URL path.

---

## Optional Workspace Root

By default, each server uses the directory where it was started as its workspace root.

To expose a larger workspace:

```bash
MCP_ROOT="$HOME" npm start
```

To expose one project:

```bash
MCP_ROOT=/path/to/project npm start
```

All file and command operations are restricted to `MCP_ROOT`.

---

## ChatGPT / Grok Connector Setup

1. Start the server locally.
2. Copy the printed **Streamable HTTP** URL:

   ```text
   https://<random>.trycloudflare.com/mcp/<API_KEY>
   ```

3. In ChatGPT or Grok, create a custom connector.
4. Paste the URL.
5. Choose **No authentication**.
6. Enable the connector in a chat.

Legacy SSE URLs are also printed for clients that require SSE:

```text
https://<random>.trycloudflare.com/sse/<API_KEY>
```

---

## Security Notes

- Free `trycloudflare.com` URLs are public internet endpoints.
- Access is protected by a high-entropy path key in the URL.
- Do **not** commit `.env`, logs, downloaded `cloudflared` binaries, or local data directories.
- Keep `MCP_ROOT` as narrow as practical for the connector you are using.
- Use the edit/read MCP for direct coding tools and the OMP MCP for full local agent delegation.

---

## Project READMEs

See each server's README for full configuration and tool details:

- [`chatbots-editreadmcp/README.md`](./chatbots-editreadmcp/README.md)
- [`chatbots-omp-as-mcp/README.md`](./chatbots-omp-as-mcp/README.md)

---

## License

MIT
