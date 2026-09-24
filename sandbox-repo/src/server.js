import { createServer } from "node:http";
import { NoteStore } from "./store.js";
import { validateNote } from "./validate.js";

const PORT = Number(process.env.PORT ?? 8080);
const store = new NoteStore(process.env.DATA_FILE ?? "notes.json");

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const match = url.pathname.match(/^\/notes\/([\w-]+)$/);

  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

  if (req.method === "GET" && url.pathname === "/notes") {
    const tag = url.searchParams.get("tag");
    return send(res, 200, await store.list(tag));
  }

  if (req.method === "POST" && url.pathname === "/notes") {
    const body = await readBody(req);
    const error = validateNote(body);
    if (error) return send(res, 400, { error });
    return send(res, 201, await store.create(body));
  }

  if (req.method === "GET" && match) {
    const note = await store.get(match[1]);
    return note ? send(res, 200, note) : send(res, 404, { error: "not found" });
  }

  if (req.method === "PUT" && match) {
    const body = await readBody(req);
    const error = validateNote(body);
    if (error) return send(res, 400, { error });
    const note = await store.update(match[1], body);
    return note ? send(res, 200, note) : send(res, 404, { error: "not found" });
  }

  send(res, 404, { error: "route not found" });
});

server.listen(PORT, () => console.log(`tiny-notes-api listening on http://localhost:${PORT}`));
