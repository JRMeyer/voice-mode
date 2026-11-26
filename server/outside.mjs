// Audio that voice-mode did not start: a clip Claude plays with afplay for you to hear, a song in ffplay, the
// macOS say command. The daemon cannot hear the machine, but it can see the programs: while one of these runs,
// the voice holds (daemon.mjs), so it never talks over them.
import { execFile } from "node:child_process";
import { basename } from "node:path";

// Every voice-mode daemon plays through sox started under this name (sox still acts as play: the name ends in
// "play"). It is how a daemon tells its own players, and other daemons', from outside audio.
export const OUR_PLAYER = "voice-mode/play";
// A daemon from 0.5.14 or before, still running after an update, started sox as plain play, with exactly these
// arguments (raw audio from stdin). Never outside audio either: the floor keeps it from talking over this one.
const OLD_OURS = /^play -q -t raw -r \d+ -e signed -b 16 -c 1 -$/;

// Command-line players. Matched by process name (ps ucomm: the executable's name, at most 15 or 16 characters,
// which macOS takes from the file a link points to) or by the name the command was run as (the first word of args).
const PLAYERS = new Set(["afplay", "ffplay", "mpv", "mplayer", "aplay", "paplay", "pw-play", "pw-cat", "say"]);

// One line of `ps -A -ww -o pid= -o stat= -o ucomm= -o args=`: is it a player voice-mode did not start?
export function isOutsidePlayer(name, args) {
  const first = args.split(/\s+/, 1)[0];
  if (first === OUR_PLAYER || OLD_OURS.test(`${basename(first)}${args.slice(first.length)}`.trim())) return false;
  const as = PLAYERS.has(name) ? name : PLAYERS.has(basename(first)) ? basename(first) : "";
  if (as === "say") return !/\s(-o|--output-file)(=|\s)/.test(args);  // say -o writes a file: nothing is heard
  if (as === "mpv") return !/\s--idle\b/.test(args);                   // mpv --idle waits, silent, for files
  if (as) return true;
  // sox: "play" is a link to it, so ps names it sox on macOS and play on Linux. sox plays when run as play, or
  // when its output is the sound card (-d).
  if (name === "sox" || name === "play") return basename(first) === "play" || /\s(-d|--default-device)(\s|$)/.test(args);
  return false;
}

// Lines of that ps output in, the pids of outside players out.
export function outsidePlayers(ps, self = process.pid) {
  const out = [];
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    // A zombie (state Z) has exited and plays nothing; it waits only for its parent to collect it.
    if (m && Number(m[1]) !== self && !m[2].startsWith("Z") && isOutsidePlayer(m[3], m[4])) out.push(Number(m[1]));
  }
  return out;
}

// Is outside audio playing now? A short cache, and one ps at a time: callers asking meanwhile share its answer.
// If ps cannot run, the answer is no: the voice goes on as it did before this check existed. onError hears why.
let cached = { at: 0, value: false }, probe = null;
export function outsideAudio({ maxAge = 200, onError = () => {} } = {}) {
  if (Date.now() - cached.at < maxAge) return Promise.resolve(cached.value);
  probe ??= new Promise(done => {
    const finish = (value, err) => { if (err) onError(err); cached = { at: Date.now(), value }; probe = null; done(value); };
    try {
      execFile("ps", ["-A", "-ww", "-o", "pid=", "-o", "stat=", "-o", "ucomm=", "-o", "args="], { timeout: 2000, maxBuffer: 16 << 20 },
        (err, stdout) => err ? finish(false, err) : finish(outsidePlayers(stdout).length > 0));
    } catch (err) { finish(false, err); }
  });
  return probe;
}
