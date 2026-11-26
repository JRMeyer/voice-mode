// Audio that voice-mode did not start: a sound Claude plays with afplay to audition it, a song in ffplay, the
// macOS say command. The daemon cannot hear the machine, but it can see the programs: while one of these runs,
// the voice waits, so it never talks over them.
import { execFile } from "node:child_process";
import { basename } from "node:path";

// Command-line players. "play" is sox, which every voice-mode daemon also uses: its own players read raw audio
// from stdin ("-t raw ... -"), and those are left out.
const PLAYERS = new Set(["afplay", "play", "ffplay", "mpv", "mplayer", "aplay", "paplay", "pw-play", "cvlc", "say"]);
const OURS = /\s-t raw\b.*\s-$/;

// Lines of `ps -Ao pid=,args=` in, the pids of outside players out.
export function outsidePlayers(ps, self = process.pid) {
  const out = [];
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)(.*)$/.exec(line);
    if (!m || Number(m[1]) === self) continue;
    if (PLAYERS.has(basename(m[2])) && !OURS.test(m[3])) out.push(Number(m[1]));
  }
  return out;
}

// Is outside audio playing now? Asked before each piece of speech, so a short cache keeps ps calls rare.
let cached = { at: 0, value: false };
export function outsideAudio({ maxAge = 200 } = {}) {
  if (Date.now() - cached.at < maxAge) return Promise.resolve(cached.value);
  return new Promise(done => {
    execFile("ps", ["-Ao", "pid=,args="], { timeout: 2000, maxBuffer: 8 << 20 }, (err, stdout) => {
      cached = { at: Date.now(), value: !err && outsidePlayers(stdout).length > 0 };
      done(cached.value);
    });
  });
}
