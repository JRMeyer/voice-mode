// voice-mode daemon: keeps the tiny-voca model loaded and plays queued speech, sounds and the working hum.
// HTTP over a Unix socket:
//   POST /say (body: text) queues it; /say?bare=1 skips the default opening sound.
//     Optional tags: kind=progress (a check-in: dropped if the turn ends or it waits over 20 s for another
//     session's voice), session=<id> (for a scoped /stop), label=<project> (said when the voice switches projects).
//   POST /stop clears the speech queue and cuts playback; /stop?session=<id> only that session's speech.
//   POST /mute: voice off at once, for every session this daemon serves (the off switch is host-wide): speech,
//     working sounds, the wait chime and queued check-ins end. /mute?click=1 then plays a click (heard, without words).
//   POST /hum/on, /hum/off: a soft "still working" sound every 12 to 20 s. /hum/off also drops queued check-ins.
//   POST /activity (body: read | write | run | web | think): which sound that is.
//   POST /wait/start (body: what to say): speak it after a chime, then chime every 30 s until /wait/stop.
//   POST /quit exits (a newer daemon for the same session asks this of the old one).
//   POST /health answers { ok: true, queued: <parts waiting> }: a client checks that a daemon is up.
// Usage: node daemon.mjs <socket path>
// Env: VOICE_MODE_JS (tiny-voca js folder, default vendor/tiny-voca), VOICE_MODE_MODEL (.gguf), VOICE_MODE_VOICE (default M2), VOICE_MODE_PLAYER (sox play),
//   VOICE_MODE_LABEL (project name to say; default: the project folder's name).
// Every daemon on the machine shares one floor (floor.mjs): only one of them plays at a time.
import { readFileSync, existsSync, unlinkSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { join, basename } from "node:path";
import { sfx, SOUND_NAMES } from "./sfx.mjs";
import { createFloor } from "./floor.mjs";

const SOCK = process.argv[2];
const T0 = Date.now();
const log = (...a) => { try { appendFileSync(SOCK + ".log", `${((Date.now() - T0) / 1000).toFixed(2)} ${a.join(" ")}
`); } catch {} };
console.log = log; console.error = log;
const JS = process.env.VOICE_MODE_JS || join(import.meta.dirname, "../vendor/tiny-voca");
const MODEL = process.env.VOICE_MODE_MODEL || join(import.meta.dirname, "../models/robo-josh.gguf");
const VOICE = process.env.VOICE_MODE_VOICE || "M2";
const LABEL = process.env.VOICE_MODE_LABEL || basename(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const floor = createFloor();
const PLAY = process.env.VOICE_MODE_PLAYER || ["/opt/homebrew/bin/play", "/usr/local/bin/play", "/usr/bin/play"].find(existsSync) || "play";

// An older daemon for this session (before a plugin reload) still holds the socket: ask it to quit first.
if (existsSync(SOCK)) {
  await new Promise(done => {
    const r = request({ socketPath: SOCK, path: "/quit", method: "POST", timeout: 800 }, res => { res.resume(); res.on("end", done); });
    r.on("error", done); r.on("timeout", () => { r.destroy(); done(); }); r.end();
  });
  try { unlinkSync(SOCK); } catch {}
}

const { readGGUF, TinyVoca } = await import(join(JS, "tiny-voca.js"));
const { fromGGUF } = await import(join(JS, "dizione/engine.js"));
const { utterancesOf, limited } = await import(join(JS, "text.js"));
const file = readGGUF(new Uint8Array(readFileSync(MODEL)).buffer);
const voca = new TinyVoca(file), phonemizer = await fromGGUF(file);
const rate = voca.config.sample_rate;

// Pronunciation fixes: "word = how to say it" lines in pronounce.txt next to this file.
const SAY_AS = (() => {
  try {
    return readFileSync(new URL("./pronounce.txt", import.meta.url), "utf8").split("\n")
      .map(l => l.replace(/#.*/, "").split("=").map(s => s.trim())).filter(([a, b]) => a && b)
      .map(([a, b]) => [new RegExp(`(?<![\\w-])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "gi"), b]);
  } catch { return []; }
})();

// Spoken text never uses contractions. Only the unambiguous ones: "'s" and "'d" stay unless listed.
const CONTRACTIONS = {
  "can't": "cannot", "won't": "will not", "shan't": "shall not", "ain't": "is not", "let's": "let us", "i'm": "i am",
  "it's": "it is", "that's": "that is", "what's": "what is", "there's": "there is", "here's": "here is",
  "who's": "who is", "where's": "where is", "he's": "he is", "she's": "she is", "how's": "how is",
};
const ENDINGS = { "n't": " not", "'ll": " will", "'re": " are", "'ve": " have" };   // the rest: "don't" is "do not"
const uncontract = t => t
  .replace(/[’]/g, "'")
  .replace(/\b([A-Za-z]+'[A-Za-z]+)\b/g, w => {
    const lower = w.toLowerCase(), end = ENDINGS[lower.slice(-3)];
    const full = CONTRACTIONS[lower] ?? (end && lower.slice(0, -3) + end);
    if (!full) return w;
    return w[0] === w[0].toUpperCase() ? full[0].toUpperCase() + full.slice(1) : full;
  })
  .replace(/\bi am\b/g, "I am");

const clean = t => {
  t = t.replace(/```[\s\S]*?```/g, " ").replace(/https?:\/\/\S+/g, " ")
    .replace(/`([^`]*)`/g, "$1").replace(/[*_#]+/g, "")
    .replace(/[→×≈]/g, m => ({ "→": " to ", "×": " times ", "≈": " about " })[m]);
  t = uncontract(t);
  for (const [re, said] of SAY_AS) t = t.replace(re, said);
  return t.replace(/\s+/g, " ").trim();
};

const pcm = (audio, gapSec) => {
  const x = limited(audio), th = 0.01;
  let a = 0, b = x.length - 1;
  while (a < b && Math.abs(x[a]) < th) a++;
  while (b > a && Math.abs(x[b]) < th) b--;
  a = Math.max(0, a - Math.round(rate * 0.01)); b = Math.min(x.length, b + Math.round(rate * 0.04));
  const out = new Int16Array(b - a + Math.round(rate * gapSec));
  for (let i = a; i < b; i++) out[i - a] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767)));
  return Buffer.from(out.buffer);
};

const rawPlayer = () => spawn(PLAY, ["-q", "-t", "raw", "-r", String(rate), "-e", "signed", "-b", "16", "-c", "1", "-"],
  { stdio: ["pipe", "ignore", "pipe"] });

// ---- speech queue ----
// draining: a player whose input is closed but which is still playing its buffer. A new player waits for it to
// exit, or two clips play over each other (a late turn-start line under a quick end summary).
// Each queued part belongs to a message: { kind, session, label, priority, at, maxWait, speaks }. The first part
// of a message is marked first. Messages are where this daemon hands the floor to another one that is waiting.
let queue = [], player = null, draining = null, busy = false, gen = 0, seed = 0, current = null;

// How long a message may wait for another session's voice before it is dropped as stale.
const MAX_WAIT = { work: 0, chime: 0, progress: 20000, wait: 120000, say: 90000 };
const PRIORITY = { wait: 1, chime: 1 };
const SWITCH_WINDOW = 10 * 60 * 1000;                            // name the project if another one spoke in the last 10 minutes

function stop(session) {
  if (session) {
    queue = queue.filter(p => p.msg.session !== session);
    if (current?.session !== session) return;                    // another session is speaking: leave it alone
  } else queue = [];
  gen++;
  for (const p of [player, draining]) if (p) { try { p.kill(); } catch {} }
  player = null; draining = null; current = null;
  if (!busy) floor.release();
}

const drop = msg => { queue = queue.filter(p => p.msg !== msg); };

// Text as queue parts: pieces short enough for the model, each tagged with its message.
const partsOf = (text, msg) => utterancesOf(text, phonemizer, voca.config.max_tokens - 12).map(p => ({ ...p, msg }));

// When the voice switches projects, a message opens with the project name, after its opening sound.
function announce(msg) {
  if (!msg.speaks) return;
  const last = floor.lastSpeaker();
  if (msg.label && last.label && last.label !== msg.label && Date.now() - last.at < SWITCH_WINDOW) {
    const name = clean(msg.label.replace(/[-_.]+/g, " "));
    const at = queue.findIndex(p => p.msg === msg && !p.sound);
    if (name && at >= 0) { log("announce", name); queue.splice(at, 0, ...partsOf(`In ${name}.`, msg)); }
  }
  floor.spoke(msg.label);
}

function startPlayer() {
  const p = player = rawPlayer();
  p.exited = new Promise(r => { p.once("exit", r); p.once("error", r); });
  p.exited.then(() => { if (draining === p) draining = null; });
  p.stderr.on("data", d => console.error("player:", String(d).trim()));
  p.on("error", err => console.error("player failed to start:", err.message));
  p.ready = new Promise(r => setTimeout(r, 300));                // sox quits if data arrives the instant it starts
  console.log("player started", p.pid);
  p.on("exit", (code, sig) => { console.log("player exit", code, sig); if (player === p) player = null; });
  p.stdin.on("error", () => {});
}

// Let the player finish what it has, then exit.
function finishPlayer() {
  if (player) { draining = player; player.stdin.end(); player = null; }
  return draining ? draining.exited : Promise.resolve();
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const my = gen, part = queue[0], msg = part.msg;
      // Between two messages, another session waiting gets its turn: finish playing, then hand over the floor.
      if (part.first && !msg.started && floor.held && floor.othersWaiting()) {
        log("yield floor");
        await finishPlayer();
        floor.release();
        if (my !== gen) continue;
      }
      if (!player) {
        if (draining) { log("wait for previous player", draining.pid); await draining.exited; }
        if (my !== gen) continue;                                // stopped while waiting
        if (!floor.held) {
          const maxWait = msg.started ? Infinity : msg.maxWait - (Date.now() - msg.at);
          if (floor.busyElsewhere()) log("wait for floor", msg.kind);
          const ok = await floor.acquire({ priority: msg.priority, maxWait, gone: () => queue[0] !== part });
          if (!ok) { if (queue[0] === part) { log("drop stale", msg.kind); drop(msg); } continue; }
          if (my !== gen) { floor.release(); continue; }
        }
        startPlayer();
      }
      if (part.first && !msg.started) { msg.started = true; current = msg; announce(msg); continue; }
      queue.shift();
      let bytes;
      if (part.sound) bytes = sfx(part.sound, rate);
      else {
        const t = Date.now();
        const audio = voca.synthesize(part.ids, part.stress, { voice: VOICE, seed: seed++ }).audio;
        log("synth", Date.now() - t, "ms for", (audio.length / rate).toFixed(2), "s");
        bytes = pcm(audio, part.end ? 0.35 : 0.18);
      }
      const p = player;
      if (my !== gen || !p) continue;                            // stopped meanwhile
      await p.ready;
      if (my !== gen || p !== player) continue;
      if (!p.stdin.write(bytes))
        await new Promise(r => { p.stdin.once("drain", r); p.once("exit", r); p.stdin.once("error", r); });  // a killed player never drains
      await new Promise(r => setImmediate(r));                   // let /stop and new /say requests in
    }
    await finishPlayer();                                        // the floor is held until the last sound is out
  } finally {
    busy = false;
    if (queue.length) setImmediate(pump);                        // a /say arrived while the last player drained
    else { current = null; floor.release(); }
  }
}

// Sound tags like [beep] play in place between the spoken pieces.
const TAG = new RegExp(`\\[(${SOUND_NAMES.join("|")})\\]`, "gi");
const OPENS_WITH_TAG = new RegExp(`^\\s*${TAG.source}`, "i");

function say(text, { bare = false, kind = "say", session = "", label = LABEL } = {}) {
  // Every message starts with a robot sound unless the caller asked for none.
  if (!bare && !OPENS_WITH_TAG.test(text)) text = "[beep] " + text;
  const msg = { kind, session, label, priority: PRIORITY[kind] ?? 0, at: Date.now(), maxWait: MAX_WAIT[kind] ?? MAX_WAIT.say, speaks: false };
  const parts = [];
  for (const [i, piece] of text.split(TAG).entries()) {
    if (i % 2) { parts.push({ sound: piece.toLowerCase(), msg }); continue; }
    const t = clean(piece.replace(/\[[^\]]*\]/g, " "));
    if (t) parts.push(...partsOf(t, msg));
  }
  if (!parts.length) return 0;
  const last = parts.findLast(p => !p.sound);
  if (last) { last.end = true; msg.speaks = true; }
  parts[0].first = true;
  // A message for someone who is needed goes ahead of routine ones not yet started.
  const at = msg.priority ? queue.findIndex(p => p.first && !p.msg.started && p.msg.priority < msg.priority) : -1;
  if (at >= 0) queue.splice(at, 0, ...parts); else queue.push(...parts);
  setImmediate(pump);
  return parts.length;
}

// ---- "still working": a short sound every 12 to 20 s while Claude works, flavoured by what it is doing ----
// reading -> riffle, writing -> type, running a command -> whir, web search or browsing -> radio, otherwise (thinking) -> beeps and boops.
const ACTIVITY_SOUND = { read: "riffle", write: "type", run: "whir", web: "radio", think: "working" };
let hum = null, activity = "think", lastWork = 0;
function workSound() {
  if (busy || queue.length || floor.busyElsewhere()) return;   // never under another session's voice
  lastWork = Date.now();
  say(`[${ACTIVITY_SOUND[activity] || "working"}]`, { bare: true, kind: "work" });
}
function humOn() {
  if (hum || waiting) return;
  log("working sounds on");
  const next = () => { hum = setTimeout(() => { if (!hum) return; workSound(); next(); }, 12000 + Math.random() * 8000); };
  next();
}
function humOff() {
  activity = "think";
  if (!hum) return;
  log("working sounds off");
  clearTimeout(hum); hum = null;
}
// The turn ended: no more working sounds, and its queued check-ins are stale now.
function endWork() {
  humOff();
  queue = queue.filter(p => p.msg.kind !== "progress" || (p.msg.started && p.msg === current));
}
function setActivity(kind) {
  if (!(kind in ACTIVITY_SOUND) || kind === activity) return;
  activity = kind;
  // A change to reading, writing, running or the web plays its sound right away, at most every 6 s.
  if (hum && kind !== "think" && Date.now() - lastWork > 6000) workSound();
}

// ---- waiting on the user: speak once, then a chime every 30 s (for up to 15 minutes) ----
let waiting = null;
// Someone needs the user: this goes ahead of other sessions' narration.
function waitStart(text, tags = {}) {
  waitStop();
  humOff();
  say(`[chime] ${text}`, { ...tags, bare: true, kind: "wait" });
  let n = 0;
  waiting = setInterval(() => { if (++n > 30) return waitStop(); if (!queue.length) say("[chime]", { ...tags, bare: true, kind: "chime" }); }, 30000);
  log("wait start");
}
function waitStop() {
  if (!waiting) return;
  clearInterval(waiting); waiting = null; log("wait stop");
}

createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    let out = { ok: true };
    const url = new URL(req.url || "/", "http://voice-mode"), path = url.pathname, q = url.searchParams;
    const tags = { session: q.get("session") || "", label: q.get("label") || LABEL };
    try {
      if (path === "/say") out.sentences = say(body, { ...tags, bare: q.get("bare") === "1", kind: q.get("kind") === "progress" ? "progress" : "say" });
      else if (path === "/stop") { log("stop", tags.session); stop(tags.session); waitStop(); }
      else if (path === "/mute") {
        log("mute"); stop(); waitStop(); humOff();
        if (q.get("click") === "1") say("[toggleoff]", { bare: true });            // heard, without words
      }
      else if (path === "/hum/on") humOn();
      else if (path === "/hum/off") endWork();
      else if (path === "/activity") setActivity(body.trim());
      else if (path === "/wait/start") waitStart(body, tags);
      else if (path === "/wait/stop") waitStop();
      else if (path === "/health") out.queued = queue.length;
      else if (path === "/quit") setImmediate(quitByPeer);
      else out = { ok: false, error: "unknown path" };
    } catch (e) { out = { ok: false, error: String(e?.message || e) }; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out));
  });
}).listen(SOCK, () => console.log(`voice-mode ready on ${SOCK}`));

let leaving = false;
function bye() {
  if (leaving) return; leaving = true;
  waitStop(); humOff();
  // Let speech already queued finish (a summary in flight across a reload), at most 20 s, then exit.
  const t0 = Date.now();
  const done = () => { try { if (existsSync(SOCK) && !replaced) unlinkSync(SOCK); } catch {} process.exit(0); };
  const tick = () => (!busy && !queue.length && !draining) || Date.now() - t0 > 20000 ? done() : setTimeout(tick, 200);
  tick();
}
// After /quit a newer daemon owns the socket path: never unlink it then.
let replaced = false;
const quitByPeer = () => { replaced = true; bye(); };
process.on("exit", () => floor.release());
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { stop(); bye(); });
