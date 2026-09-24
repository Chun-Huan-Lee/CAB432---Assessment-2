# ACP Chat Web Client

This folder contains a small browser client for the [Agent Client Protocol](https://agentclientprotocol.com) and a deterministic ACP agent for local testing.

The browser connects directly to the ACP agent over WebSocket. There is deliberately no bridge or model provider in this project.

## Run locally

From this directory:

```bash
npm install

# Terminal 1: deterministic ACP agent
npm run server

# Terminal 2: Vite development server
npm run dev
```

Open <http://127.0.0.1:5173/>. The client connects automatically to the endpoint set near the top of `web/main.ts`:

```text
ws://127.0.0.1:7331/acp
```

Ask the agent to `show me an image` to exercise both native ACP image content and the Markdown image fallback. The deterministic server also exposes the image at `/deterministic-image.svg` and a health check at `/healthz`.

Students can edit the visible text directly in `index.html`: the page title, heading, subtitle, initial messages-pane text, placeholder, button labels, and theme labels are all there. The only client setting in TypeScript is the marked `ACP_WEBSOCKET_ENDPOINT` constant at the top of `web/main.ts`.

The endpoint must be reachable directly by the browser; the image does not proxy or start an ACP agent.

## Docker

The Docker image serves the built static web client only. It does not proxy or start an ACP agent.

```bash
docker build -t acp-chat-web-client .
docker run --rm -p 8080:80 acp-chat-web-client
```

For an HTTPS deployment, set a `wss://` endpoint in `web/main.ts`. The theme toggle switches between light and dark mode and remembers the choice in the browser; the default behavior follows the system theme.

When the deterministic server is bound to all interfaces, set the public origin used in its image Markdown response:

```bash
PUBLIC_ORIGIN=http://localhost:7331 npm run server -- --host 0.0.0.0
```

## Development commands

```bash
npm run dev       # Vite development server
npm run server    # deterministic ACP WebSocket/HTTP server
npm test          # unit tests for the deterministic agent
npm run build     # production bundle and TypeScript check
```

## Scope

The client implements the small subset needed for ordinary conversations:

- ACP initialization and session creation
- streamed assistant text
- native assistant image content
- user image attachments (attach an image to send alongside text)
- Markdown rendering with sanitization
- cancellation
- display of agent thinking/tool activity as status text

It intentionally does not implement filesystem access, terminal sessions, code diffs, authentication, or persistent session loading. The deterministic server rejects permission requests rather than granting them automatically.
