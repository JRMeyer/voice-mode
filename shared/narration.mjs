// What the three hosts share: the narrator prompts, the "got it" lines, asking in plain words for silence or for
// the voice back, and how tool calls are described and timed. Claude Code (hooks/register.ts), Codex (codex/) and
// OpenCode (opencode/) all import it. No imports and no side effects: Claude Code loads it in a sandbox without
// Node. Its types are in narration.d.mts.

// ---- the narrator ----
export const NARRATOR = `You are the spoken voice of a coding assistant, a friendly 1980s toy robot like 2-XL.
You turn what the assistant is doing into speech for the user, who is listening, not reading.
Never use contractions in spoken text: say "it is", "cannot", "will not", "I am", "do not", "that is", never "it's", "can't", "won't", "I'm", "don't", "that's".
Rules: short clipped sentences, a few words each, simple terse robot grammar, facts exact (keep numbers, names and times as given; never invent any).
Never read out paths, URLs, code, commands, symbols, tables or lists.
Sounds, sparingly: begin with one sound tag; at most one more, only for a real result ([success] or [error]). Tags: [beep] [boop] [click] [servo] [think] [success] [error] [boot].
Reply with the spoken line only, no quotes, no preamble. Keep within the word limit the request gives.`;

// Earlier spoken lines, so the narrator says only what is new.
const SAID = said => said.length
  ? `What you already said to the user earlier in this conversation (oldest first):\n${said.map(x => `- ${x}`).join("\n")}\nThe user heard all of that. Never say it again, not even reworded: no repeated acknowledgments, plans, check-in intervals or results. Say only what is new.\n`
  : "";

export const ASK = {
  start: (prompt, said = []) =>
    `${SAID(said)}The user just asked:\n<<<${prompt.slice(0, 1500)}>>>\nAcknowledge it in at most eight words, like "Got it. On it." or "Query received. Working." You know NOTHING yet about the answer, the status, or what has been done: never state or guess any progress, results, numbers, or plans, and never answer the question.`,
  progress: (prompt, steps, event, said = []) =>
    `${SAID(said)}The user asked:\n<<<${prompt.slice(0, 600)}>>>\nRecent steps (oldest first):\n${steps.join("\n")}\n${event ? `What just happened: ${event}\nTell the user about that in one or two short sentences, at most 25 words, plainly saying whether it went well.` : "Give a short progress check-in: what is happening now, at most 25 words."} Do not reply to the user's request itself; it was already acknowledged. If nothing new happened since your last line, say only a few words, like "Still working." Do not announce a final answer.`,
  end: (prompt, answer, steps = [], said = []) =>
    `${SAID(said)}The user asked:\n<<<${prompt.slice(0, 600)}>>>\n${steps.length >= 3 ? `The assistant worked through ${steps.length} or more steps, the last ones:\n${steps.slice(-8).join("\n")}\n` : ""}The assistant's written answer:\n<<<${answer.slice(0, 6000)}>>>\nYou are talking WITH the user in a conversation, not reading the answer aloud. The user does not read the screen, so tell them what they'd want to hear, the way a sharp colleague would say it out loud: the point first, then only the one or two facts that matter, then the question or next step if there is one. If the assistant worked through several steps, open with one short sentence saying what it did, in plain words (for example "I added the new sounds and pushed them."), so the user is never left wondering what happened. Two to five sentences, at most 70 words. Leave out identifiers nobody says aloud: commit hashes, repo or file names, paths, IDs, flags, exact version strings, long lists. Round numbers the way people speak them. Don't recap everything that was done. Only when the answer contains something meant to be looked at (a table, a code block, a command), mention it once in a few words, e.g. "The table is on screen." A result tone has already played: use no sound tags in this line.`,
};

// Words to say when no narrator model is available.
export const FALLBACK = {
  progress: () => "[think] Still working.",
  end: (_p, answer) => answer.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").replace(/[#*_>|]/g, " ").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).slice(0, 2).join(" "),
};

// Sound tags like [beep] taken out: for a line spoken bare, and for remembering what was said.
export const stripTags = text => String(text).replace(/\[[a-z]+\]/gi, " ").trim();

// The last ten lines spoken aloud, with a new one added.
export function addSaid(said, text) {
  const line = stripTags(text).replace(/\s+/g, " ");
  return line ? [...said, line].slice(-10) : said;
}

// ---- asking in plain words for silence, or for the voice back ----
// "stop talking to the server" is about code, not the voice: talking/speaking followed by "to the/a/an" does not count.
const HUSH = /\b(stop|quit|no more|enough) (talking|speaking|narrating|narration|chattering)\b(?! to (the|a|an)\b)|\b(go|be|stay|keep) (quiet|silent)\b|\bshut up\b|\b(mute|silence) (yourself|the voice|voice|it)\b|\bvoice( mode)? off\b|^\W*(mute|silence|quiet|hush|shh+)\W*$/i;
const UNHUSH = /\b(you can|you may|feel free to|ok(ay)? to) (talk|speak)\b|\b(start|resume) (talking|speaking)\b|\bvoice( mode)? on\b|\bunmute\b|\btalk to me again\b/i;
export const wantsQuiet = text => HUSH.test(text);
export const wantsVoice = text => UNHUSH.test(text) && !HUSH.test(text);

// ---- acknowledgments ----
// The "got it" line after you press Enter. Fixed phrases play at once; a model line would take seconds.
// Only confirms the message arrived. It must fit any message, so it says nothing about what was asked.
export const ACKS = [
  "Got it.", "Message received.", "Received.", "Copy that.", "Request received.",
  "Input received.", "Transmission received.", "Signal received.", "Copy.", "Message logged.",
];

// A random acknowledgment, never the same one twice in a row: its index in ACKS.
export function pickAck(last) {
  const i = Math.floor(Math.random() * ACKS.length);
  return i === last ? (i + 1) % ACKS.length : i;
}

// ---- describing what the agent does ----
// Tool names differ by host: Claude Code (Read, Edit, Bash), Codex (apply_patch, exec_command, web_search),
// OpenCode (read, edit, bash, webfetch).
const pickArg = input => {
  if (typeof input === "string") return input;
  const o = input && typeof input === "object" ? input : {};
  const v = ["description", "command", "cmd", "file_path", "pattern", "path", "query", "prompt", "url"].map(k => o[k]).find(x => x && (typeof x === "string" || Array.isArray(x)));
  return Array.isArray(v) ? v.join(" ") : v ?? "";
};
export const describeCall = (tool, input) => `${String(tool).replace(/^mcp__/, "")}: ${String(pickArg(input)).replace(/\s+/g, " ").slice(0, 160)}`;

// Web search, fetching a page, or driving a browser (built-in web tools, or browser and Chrome MCP tools).
const WEB = /^(web_search|web_fetch|web_run|webfetch|websearch|codesearch)$|^mcp__.*(chrome|browser|playwright|puppeteer)/i;

// What kind of work a tool call is, for the "still working" sound.
export function activityOf(tool) {
  if (WEB.test(tool)) return "web";
  if (/^(read|grep|glob|ls|list|list_dir|view_image|notebookread|toolsearch|listmcpresourcestool|readmcpresourcetool)$/i.test(tool)) return "read";
  if (/^(apply_patch|patch|edit|multiedit|write|notebookedit)$/i.test(tool)) return "write";
  return "run";
}

export function approvalLine(tool) {
  const what = /^(bash|shell|exec_command|local_shell|unified_exec)$/i.test(tool) ? "to run a command"
    : activityOf(tool) === "write" ? "to change a file"
    : /^mcp__/.test(tool) || /^web_/i.test(tool) || /^(WebFetch|WebSearch)$/.test(tool) ? "to use an outside tool" : "for the next step";
  return `I need your approval ${what}. It is on screen.`;
}

// What to say when the user has to answer a question on screen.
export function questionLine(input) {
  const qs = (input?.questions ?? []).slice(0, 2);
  if (!qs.length) return "I have a question for you on screen.";
  const one = q => {
    const opts = (q.options ?? []).map(o => o.label).filter(Boolean);
    const list = opts.length > 1 ? ` The choices are: ${opts.slice(0, -1).join(", ")}, or ${opts[opts.length - 1]}.` : "";
    return `${String(q.question ?? "").replace(/\s+/g, " ").trim()}${list}`;
  };
  return `${qs.length > 1 ? "Two questions on screen. " : "Question on screen. "}${qs.map(one).join(" Next. ")}`;
}

// ---- check-ins and the result tone ----
// After each step: keep the last 12 steps, and say whether a spoken check-in is due. A step of 30 s or more is an
// event, worth a note if nothing was said for 45 s. Otherwise a check-in after 2 quiet minutes, on turns over 45 s.
export function afterStep(turn, step, started, now = Date.now()) {
  turn.steps = [...turn.steps, step].slice(-12);
  const took = Math.round((now - started) / 1000);
  const event = took >= 30 ? `${step} (took ${took} seconds)` : undefined;
  const quiet = now - Math.max(turn.lastSpoke, turn.t0);
  return { event, due: event ? quiet > 45000 : now - turn.t0 > 45000 && quiet > 120000 };
}

// Did the turn go badly? The first lines of the answer say so, or the last steps failed.
function wentBadly(answer, steps) {
  const head = answer.slice(0, 400);
  if (/\b(fail(s|ed|ing)?|error|broken|broke|could ?n[o']t|can ?n[o']t|did ?n[o']t work|does ?n[o']t work|not working|blocked|crash(ed|es)?)\b/i.test(head)
    && !/\b(fixed|works now|passed|resolved)\b/i.test(head)) return true;
  return steps.slice(-2).length === 2 && steps.slice(-2).every(x => x.endsWith("(failed)"));
}

// The tone before the end summary, on turns over 8 s: the outcome in half a second, then the words.
export const resultTone = (answer, steps, t0) => Date.now() - t0 > 8000 ? (wentBadly(answer, steps) ? "[error]" : "[success]") : "";
