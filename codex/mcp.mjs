// A tiny MCP server (stdio, newline-delimited JSON-RPC) for Codex: the `voice_mode` on/off switch. Codex has no plugin slash commands, so on/off is a tool the model calls
// when the user says "voice off" or "voice on".
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { ensureDaemon, setOff, mute } from "./lib.mjs";

// The plugin's own version, for the server info Codex shows.
const { version } = JSON.parse(readFileSync(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"));

const TOOLS = [
  {
    name: "voice_mode",
    description: "Turn spoken replies and sounds on or off. Call it when the user asks to turn voice (voice mode) on or off, or to mute or unmute it.",
    inputSchema: { type: "object", properties: { on: { type: "boolean", description: "true turns voice on, false turns it off." } }, required: ["on"] },
  },
];

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

async function callTool(name, args = {}) {
  if (name === "voice_mode") {
    setOff(!args.on);
    if (args.on) await ensureDaemon();
    else await mute().catch(() => {});
    return text(args.on ? "Voice on. You will hear spoken replies as Codex works." : "Voice off. Replies are text only.");
  }
  return text(`Unknown tool ${name}.`, true);
}

const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

createInterface({ input: process.stdin }).on("line", async line => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return; // notifications need no reply
  try {
    if (m.method === "initialize")
      send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "voice-mode", version } } });
    else if (m.method === "tools/list") send({ id: m.id, result: { tools: TOOLS } });
    else if (m.method === "tools/call") send({ id: m.id, result: await callTool(m.params?.name, m.params?.arguments) });
    else if (m.method === "ping") send({ id: m.id, result: {} });
    else send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  } catch (err) {
    send({ id: m.id, error: { code: -32603, message: String(err) } });
  }
});
