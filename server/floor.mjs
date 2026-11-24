// The floor: one voice at a time across every voice-mode daemon on the machine.
// Each Claude Code session runs its own daemon and Codex runs a shared one. Before a daemon starts its
// player it takes the floor, a lock file in the voice-mode home; it gives the floor back when its player exits,
// or between two messages when another daemon is waiting.
// Waiting daemons leave a want file. The best one takes the floor next: higher priority first (someone
// needs the user), then whoever has waited longest. A lock or want file whose process is gone is ignored.
// Also kept here: who spoke last, so a line can name its project when the voice switches projects.
import { mkdirSync, linkSync, renameSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const isAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createFloor({ home = process.env.VOICE_MODE_HOME || join(homedir(), ".voice-mode"), pid = process.pid, alive = isAlive } = {}) {
  mkdirSync(home, { recursive: true });
  const LOCK = join(home, "floor.lock"), LAST = join(home, "floor-last.json");
  const wantFile = p => join(home, `floor-want-${p}.json`);
  let mine = false;

  const holder = () => {
    try { return Number(readFileSync(LOCK, "utf8")) || 0; } catch { return 0; }
  };

  function tryLock() {
    // Write the pid first, then link it into place: the lock file is never seen empty, and link fails if it exists.
    const tmp = join(home, `floor-${pid}.tmp`);
    writeFileSync(tmp, String(pid));
    try {
      for (let i = 0; i < 2; i++) {
        try {
          linkSync(tmp, LOCK);
          return (mine = true);
        } catch (e) {
          if (e.code !== "EEXIST") return false;
          const h = holder();
          if (h === pid) return (mine = true);
          if (!h || alive(h)) return false;
          // Its daemon died holding it. Move it aside first, so two daemons cleaning up never delete a fresh lock.
          const aside = join(home, `floor-stale-${pid}.tmp`);
          try { renameSync(LOCK, aside); if (Number(readFileSync(aside, "utf8")) !== h) renameSync(aside, LOCK); else unlinkSync(aside); } catch {}
        }
      }
      return false;
    } finally { try { unlinkSync(tmp); } catch {} }
  }

  // Other daemons waiting for the floor, live ones only: [{ pid, priority, since }].
  function wanters() {
    let names = [];
    try { names = readdirSync(home); } catch {}
    const out = [];
    for (const n of names) {
      const m = /^floor-want-(\d+)\.json$/.exec(n);
      if (!m || Number(m[1]) === pid) continue;
      const p = Number(m[1]);
      if (!alive(p)) { try { unlinkSync(join(home, n)); } catch {} continue; }
      try { out.push({ pid: p, ...JSON.parse(readFileSync(join(home, n), "utf8")) }); } catch {}
    }
    return out;
  }

  const unwant = () => { try { unlinkSync(wantFile(pid)); } catch {} };

  // Wait for the floor. Gives up (false) after maxWait ms, or as soon as gone() says the message is no longer wanted.
  async function acquire({ priority = 0, maxWait = Infinity, gone = () => false } = {}) {
    if (mine && holder() === pid) return true;
    mine = false;
    const since = Date.now();
    writeFileSync(wantFile(pid), JSON.stringify({ priority, since }));
    try {
      for (;;) {
        if (gone()) return false;
        const ahead = wanters().some(w => w.priority > priority || (w.priority === priority && w.since < since));
        if (!ahead && tryLock()) return true;
        if (Date.now() - since >= maxWait) return false;
        await sleep(60);
      }
    } finally { unwant(); }
  }

  function release() {
    if (!mine) return;
    mine = false;
    if (holder() === pid) try { unlinkSync(LOCK); } catch {}
  }

  // Is the floor held by another live daemon right now?
  const busyElsewhere = () => { const h = holder(); return !!h && h !== pid && alive(h); };

  // Who spoke last, machine-wide: { label, at }.
  const lastSpeaker = () => { try { return JSON.parse(readFileSync(LAST, "utf8")); } catch { return {}; } };
  const spoke = label => { try { writeFileSync(LAST, JSON.stringify({ label, at: Date.now() })); } catch {} };

  return {
    acquire, release, busyElsewhere, lastSpeaker, spoke,
    get held() { return mine; },
    othersWaiting: () => wanters().length > 0,
  };
}
