// Talking to a voice daemon (daemon.mjs) over its Unix socket, and starting one, for the Codex and OpenCode sides.
// Claude Code's side uses the engine's own HTTP client, in hooks/register.ts.
import { request } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DAEMON = fileURLToPath(new URL("./daemon.mjs", import.meta.url));

// POST to the daemon. tags ({ session, label }) are added to the paths that use them.
export function post(sock, path, body = "", tags = {}, timeout = 3000) {
  const q = new URLSearchParams(Object.entries(tags).filter(([, v]) => v)).toString();
  if (q && /^\/(say|stop|wait\/start)\b/.test(path)) path += (path.includes("?") ? "&" : "?") + q;
  return new Promise((done, fail) => {
    const r = request({ socketPath: sock, path, method: "POST", timeout }, res => {
      let t = "";
      res.on("data", c => (t += c));
      res.on("end", () => { try { done(JSON.parse(t)); } catch { done({ ok: false, error: t }); } });
    });
    r.on("error", fail);
    r.on("timeout", () => { r.destroy(); fail(new Error("timeout")); });
    r.end(body);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Speak a line. While a new daemon loads its model (a few seconds), the socket is not up yet: retry for 8 s.
export async function say(sock, text, { bare = false, kind = "", tags = {} } = {}) {
  const path = (bare ? "/say?bare=1" : "/say") + (kind ? `${bare ? "&" : "?"}kind=${kind}` : "");
  for (let i = 0; ; i++) {
    try { return await post(sock, path, text, tags); }
    catch (err) { if (i >= 15) throw err; await sleep(500); }
  }
}

// Voice off at once, for every session this daemon serves (the off switch is host-wide): speech, working sounds,
// the wait chime and queued check-ins end. click: then a click, heard without words.
// A daemon from 0.5.7 or before, still running after an update, has no /mute: the same through the calls it knows.
export async function mute(sock, { click = false } = {}) {
  const r = await post(sock, click ? "/mute?click=1" : "/mute");
  if (r.ok || r.error !== "unknown path") return r;
  for (const path of ["/stop", "/wait/stop", "/hum/off"]) await post(sock, path);
  return click ? post(sock, "/say?bare=1", "[click]") : { ok: true };
}

// Start a daemon on sock unless one already answers there.
export async function ensureDaemon(sock, { node = process.execPath, onError = () => {} } = {}) {
  if (await post(sock, "/health", "", {}, 800).then(r => r.ok, () => false)) return;
  const child = spawn(node, [DAEMON, sock], { detached: true, stdio: "ignore", env: process.env });
  child.on("error", onError);
  child.unref();
}
