// Codex hook entry point: `node hook.mjs` reads one hook event as JSON on stdin.
// Most events return immediately. Stop waits for the final summary to reach the audio queue.
// Progress narration runs in a detached copy (`node hook.mjs narrate`).
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOME, post, say, setSession, ensureDaemon, isOff, setOff, wantsQuiet, wantsVoice, loadTurn, saveTurn, describeCall, activityOf, approvalLine, wentBadly, narrate, narrateLater, ACKS,
} from "./lib.mjs";

const quiet = p => p.catch(() => {});

async function readStdin() {
  let t = "";
  for await (const c of process.stdin) t += c;
  try { return JSON.parse(t); } catch { return {}; }
}

function failedResult(res) {
  if (!res || typeof res !== "object") return /\b(exit code [1-9]|error:)/i.test(String(res ?? ""));
  return res.success === false || res.is_error === true || res.isError === true || (typeof res.exit_code === "number" && res.exit_code !== 0);
}

async function main() {
  if (process.argv[2] === "narrate") {
    const j = JSON.parse(process.env.VOICE_MODE_JOB || "{}");
    return narrate(j.kind, j.sid, j.turnId, j.args, j.bare);
  }
  const e = await readStdin();
  if (process.env.VOICE_MODE_DEBUG) try { appendFileSync(join(HOME, "codex-hooks.log"), JSON.stringify(e) + "\n"); } catch {}
  const event = e.hook_event_name;
  const sid = e.session_id;
  const tool = String(e.tool_name ?? "");
  // Speech is tagged with this session (a new message stops only its own speech) and its project.
  setSession(sid, e.cwd);

  if (event === "SessionStart") return ensureDaemon();
  // "stop talking", "go quiet": voice off at once, like asking for it. "You can talk again" turns it back on.
  if (event === "UserPromptSubmit") {
    const text = String(e.prompt ?? "");
    if (wantsQuiet(text) && !isOff()) {
      setOff(true);
      await quiet(post("/stop")); await quiet(post("/wait/stop")); await quiet(post("/hum/off"));
      await quiet(post("/say?bare=1", "[click]"));                // heard, without words
      return;
    }
    if (wantsVoice(text) && isOff()) setOff(false);
  }
  if (isOff()) return;

  if (event === "UserPromptSubmit") {
    await ensureDaemon();
    await quiet(post("/stop"));
    const prompt = String(e.prompt ?? "");
    if (!prompt.trim()) return;
    const id = String(e.turn_id ?? Date.now());
    // A random acknowledgment, never the same one twice in a row.
    const last = loadTurn(sid)?.ack;
    let ack = Math.floor(Math.random() * ACKS.length);
    if (ack === last) ack = (ack + 1) % ACKS.length;
    saveTurn(sid, { id, prompt, t0: Date.now(), lastSpoke: 0, steps: [], busyUntil: 0, calls: {}, ack, cwd: e.cwd });
    await quiet(post("/hum/on"));
    await quiet(say(`[beep] ${ACKS[ack]}`));
    return;
  }

  const turn = loadTurn(sid);
  if (!turn || turn.done) return;

  if (event === "PermissionRequest") {
    await quiet(post("/wait/start", approvalLine(tool)));
    turn.waiting = true;
    return saveTurn(sid, turn);
  }

  if (event === "PreToolUse") {
    turn.calls[e.tool_use_id ?? tool] = Date.now();
    saveTurn(sid, turn);
    return quiet(post("/activity", activityOf(tool)));
  }

  if (event === "PostToolUse") {
    if (turn.waiting) { turn.waiting = false; await quiet(post("/wait/stop")); await quiet(post("/hum/on")); }
    await quiet(post("/activity", "think"));
    const started = turn.calls[e.tool_use_id ?? tool] ?? Date.now();
    delete turn.calls[e.tool_use_id ?? tool];
    const step = describeCall(tool, e.tool_input) + (failedResult(e.tool_response) ? " (failed)" : "");
    turn.steps = [...turn.steps, step].slice(-12);
    const now = Date.now(), took = Math.round((now - started) / 1000);
    // A long step just finished: a heavier sound, and a short spoken note if nothing was said lately.
    const happened = took >= 30 ? `${step} (took ${took} seconds)` : undefined;
    if (happened) quiet(post("/say?bare=1", "[thunk]"));
    const silent = now - Math.max(turn.lastSpoke, turn.t0);
    const due = happened ? silent > 45000 : now - turn.t0 > 45000 && silent > 120000;
    if (due && now > turn.busyUntil) {
      turn.busyUntil = now + 15000;
      narrateLater("progress", sid, turn.id, [turn.prompt, turn.steps, happened]);
    }
    return saveTurn(sid, turn);
  }

  if (event === "Stop") {
    turn.done = true;
    saveTurn(sid, turn);
    await quiet(post("/wait/stop"));
    await quiet(post("/hum/off"));
    const answer = String(e.last_assistant_message ?? "").trim();
    if (!answer) {
      appendFileSync(join(HOME, "codex-narrator.log"), `${new Date().toISOString()} end SKIPPED missing last_assistant_message\n`);
      return;
    }
    // The result tone first: the outcome in half a second, then the words.
    if (Date.now() - turn.t0 > 8000) await quiet(say(wentBadly(answer, turn.steps) ? "[error]" : "[success]", true));
    // Finish queuing the summary before the Stop hook exits.
    await narrate("end", sid, turn.id, [turn.prompt, answer, turn.steps], true);
  }
}

main().catch(err => { try { appendFileSync(join(HOME, "codex-narrator.log"), `${new Date().toISOString()} hook FAILED ${err.message}\n`); } catch {} }).finally(() => process.exit(0));
