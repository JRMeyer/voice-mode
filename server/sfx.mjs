// Robot cues and sampled button sounds. sfx() returns 16-bit mono PCM.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
// Aim: mechanical (servos, relays, computer chatter) more than video game. Generic, made from scratch.

const TAU = Math.PI * 2;
const waves = {
  sine: p => Math.sin(p),
  round: p => Math.sin(p) + 0.18 * Math.sin(2 * p),                 // soft, a little body
  square: p => (Math.sin(p) + Math.sin(3 * p) / 3 + Math.sin(5 * p) / 5) * 0.85,
  tri: p => (2 / Math.PI) * Math.asin(Math.sin(p)),
  buzz: p => [1, 2, 3, 4, 5, 6].reduce((s, h) => s + Math.sin(h * p) / h, 0) * 0.6,  // motor-ish saw
};

// Adds a tone into buf at time `at` (s). f is Hz or [from, to] (exponential sweep).
function tone(buf, rate, at, dur, f, { wave = "round", vol = 1, att = 0.004, rel = 0.02, vib = 0 } = {}) {
  const n = Math.round(dur * rate), s0 = Math.round(at * rate);
  const [f0, f1] = Array.isArray(f) ? f : [f, f];
  const a = Math.max(1, Math.min(n / 4, att * rate)), r = Math.max(1, Math.min(n / 3, rel * rate));
  let ph = 0;
  for (let k = 0; k < n && s0 + k < buf.length; k++) {
    const fr = f0 * Math.pow(f1 / f0, k / n) * (1 + vib * Math.sin(TAU * 7 * k / rate));
    ph += TAU * fr / rate;
    buf[s0 + k] += waves[wave](ph) * Math.min(1, k / a, (n - k) / r) * vol;
  }
}

// Adds noise band-passed from lo to hi Hz by two one-pole filters (without lo: low-passed only; without hi:
// high-passed only), shaped by env(x, k): x runs from 0 to 1 over the sound, k counts samples.
function noise(buf, rate, at, dur, { lo = 0, hi = Infinity, vol = 1, env = () => 1 } = {}) {
  const n = Math.round(dur * rate), s0 = Math.round(at * rate);
  const gh = 1 - Math.exp(-TAU * hi / rate), gl = 1 - Math.exp(-TAU * lo / rate);
  let a = 0, c = 0;                                             // a: the noise low-passed at hi; c: a low-passed at lo
  for (let k = 0; k < n && s0 + k < buf.length; k++) {
    a += gh * (Math.random() * 2 - 1 - a); c += gl * (a - c);
    buf[s0 + k] += (a - c) * env(k / n, k) * vol;
  }
}

// Decode each bundled WAV once at the model's playback rate, using the existing SoX installation.
const sox = ["/opt/homebrew/bin/sox", "/usr/local/bin/sox", "/usr/bin/sox"].find(existsSync) || "sox";
const recordings = new Map();
function recording(name, rate) {
  const key = name + ":" + rate;
  if (!recordings.has(key)) {
    const path = join(import.meta.dirname, "../assets/button-sounds", name + ".wav");
    try {
      const raw = execFileSync(sox, [path, "-t", "f32", "-c", "1", "-r", String(rate), "-"],
        { stdio: ["ignore", "pipe", "pipe"], maxBuffer: rate * 4 * 9 });
      recordings.set(key, new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4));
    } catch (err) {
      console.error("Could not load button sound", name, err.message);
      recordings.set(key, null);
    }
  }
  return recordings.get(key);
}

// Same layout as the original Button Sounds sprite map: press n starts at n s and plays 190 ms,
// release n starts 200 ms later and plays 790 ms. Press and release takes are picked independently.
function button(buf, rate, at, name, takes, gain, releaseAfter) {
  const source = recording(name, rate);
  if (!source) return false;
  const pick = () => 1 + Math.floor(Math.random() * takes);
  const mix = (start, dest, duration, volume) => {
    const src = Math.round(start * rate), dst = Math.round(dest * rate);
    const n = Math.min(Math.round(duration * rate), source.length - src, buf.length - dst);
    for (let i = 0; i < n; i++) buf[dst + i] += source[src + i] * volume;
  };
  mix(pick(), at, 0.19, gain);
  if (releaseAfter !== undefined) mix(pick() + 0.2, at + releaseAfter, 0.79, gain);
  return true;
}

function click(buf, rate, at, vol = 1) {
  noise(buf, rate, at, 0.012, { hi: 6000, vol: 1.6 * vol, env: x => Math.exp(-x * 9) });
  tone(buf, rate, at, 0.02, 2400, { wave: "sine", vol: 0.35 * vol, att: 0.0005, rel: 0.018 });
  noise(buf, rate, at + 0.028, 0.008, { hi: 4000, vol: 0.7 * vol, env: x => Math.exp(-x * 9) });   // the bounce
}

function servo(buf, rate, at, dur, [f0, f1] = [95, 150], vol = 1) {
  // motor hum + gear whine + brushy noise, swelling in and out
  const env = x => Math.sin(Math.PI * Math.min(1, x * 1.15)) ** 0.6;
  const n = Math.round(dur * rate), s0 = Math.round(at * rate);
  let ph = 0;
  for (let k = 0; k < n; k++) {
    const x = k / n, fr = f0 * Math.pow(f1 / f0, Math.sin(x * Math.PI / 2));
    ph += TAU * fr / rate;
    const wob = 1 + 0.15 * Math.sin(TAU * 23 * k / rate);
    buf[s0 + k] += (waves.buzz(ph) * 0.8 + Math.sin(ph * 8) * 0.16) * wob * env(x) * vol;
  }
  noise(buf, rate, at, dur, { lo: 2500, vol: 0.35 * vol, env });
}

const SOUNDS = {
  beep: (b, r) => { tone(b, r, 0, 0.1, 1100, { vib: 0.004 }); return 0.1; },
  boop: (b, r) => { tone(b, r, 0, 0.15, [640, 430]); return 0.15; },
  success: (b, r) => { tone(b, r, 0, 0.08, 880); tone(b, r, 0.09, 0.2, 1320, { vib: 0.01, rel: 0.08 }); return 0.29; },
  error: (b, r) => { tone(b, r, 0, 0.32, [190, 150], { wave: "square" }); return 0.32; },
  click: (b, r) => { click(b, r, 0); return 0.05; },
  toggleoff: (b, r) => {
    if (!button(b, r, 0, "guitar-toggle-off", 6, 1, 0.09)) click(b, r, 0);
    return 0.21;
  },
  servo: (b, r) => { servo(b, r, 0, 0.45); click(b, r, 0.46, 0.6); return 0.5; },
  think: (b, r) => {                                           // computer chatter: fast random blips with gaps
    let t = 0;
    while (t < 0.62) {
      if (Math.random() < 0.18) { t += 0.03; continue; }
      const d = 0.022 + Math.random() * 0.02;
      tone(b, r, t, d, 1200 + Math.random() * 2200, { wave: "sine", vol: 0.8, att: 0.001, rel: 0.004 });
      t += d + 0.006;
    }
    return t;
  },
  boot: (b, r) => {
    click(b, r, 0); servo(b, r, 0.06, 0.5, [70, 160]);
    tone(b, r, 0.12, 0.42, [200, 1400], { wave: "tri", vol: 0.5, rel: 0.05 });
    tone(b, r, 0.62, 0.07, 1400); tone(b, r, 0.73, 0.07, 1400); return 0.8;
  },
};

export function sfx(name, rate, gapSec = 0.1, volume = 0.22) {
  const buf = new Float32Array(Math.round(rate * 3));
  const len = SOUNDS[name](buf, rate);
  const out = new Int16Array(Math.round((len + gapSec) * rate));
  for (let i = 0; i < Math.min(out.length, buf.length); i++)
    out[i] = Math.round(Math.max(-1, Math.min(1, buf[i] * volume)) * 32767);
  return Buffer.from(out.buffer);
}

// "Your turn": a soft two-note bell, unlike any of the robot sounds above.
SOUNDS.chime = (b, r) => {
  const bell = (at, f) => { tone(b, r, at, 0.9, f, { wave: "sine", vol: 0.9, att: 0.003, rel: 0.85 }); tone(b, r, at, 0.5, f * 2.76, { wave: "sine", vol: 0.12, att: 0.002, rel: 0.45 }); };
  bell(0, 988); bell(0.22, 740); return 1.15;
};
// A heavier event sound: a long step finished.
SOUNDS.thunk = (b, r) => {
  if (button(b, r, 0, "low-thumps", 6, 2)) return 0.12;
  tone(b, r, 0, 0.12, [160, 90], { wave: "round", vol: 1.1, att: 0.002, rel: 0.09 }); click(b, r, 0, 0.8); return 0.14; };

// "Still working": two or three soft random beeps and boops, quieter than the other sounds.
SOUNDS.working = (b, r) => {
  let t = 0;
  const n = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < n; i++) {
    const up = Math.random() < 0.5, f = 600 + Math.random() * 700, d = 0.07 + Math.random() * 0.05;
    tone(b, r, t, d, up ? [f, f * 1.25] : [f * 1.2, f * 0.85], { wave: "round", vol: 0.5, att: 0.004, rel: 0.03 });
    t += d + 0.05 + Math.random() * 0.06;
  }
  return t;
};

// Activity flavours of the "still working" sound.
SOUNDS.riffle = (b, r) => {                                     // reading: thumbing through a Rolodex, about 20 thin cards
  const card = at => noise(b, r, at, 0.018, {                  // one card: a short burst of papery noise, 1.5 to 7 kHz
    lo: 1500, hi: 7000, vol: 0.35 + Math.random() * 0.2, env: x => Math.min(1, x * 12) * Math.exp(-x * 5),
  });
  for (let i = 0; i < 20; i++) card(i * 0.028 + Math.random() * 0.006);
  return 0.58;
};
// Writing: three short words on the Hi75, with synthesized keys as a fallback.
const bandNoise = (b, r, at, dur, vol, lo, hi, decay) =>       // noise band-passed lo..hi Hz, decaying
  noise(b, r, at, dur, { lo, hi, vol, env: (_, k) => Math.exp(-k / (decay * r)) });
const ring = (b, r, at, f, vol, decay) => {                     // short resonance of keycap and case
  const s0 = Math.round(at * r), n = Math.round(decay * 6 * r); let ph = 0;
  for (let k = 0; k < n && s0 + k < b.length; k++) { ph += TAU * f / r; b[s0 + k] += Math.sin(ph) * vol * Math.min(1, k / 24) * Math.exp(-k / (decay * r)); }
};
const keyPress = (b, r, t, v, space = false) => {               // press, then release after a 60 to 110 ms hold (space: 80 to 130 ms)
  const hold = (space ? 0.08 : 0.06) + Math.random() * 0.05;
  if (button(b, r, t, space ? "hi75-space" : "hi75-soft", space ? 6 : 7, v, hold)) return;
  bandNoise(b, r, t, 0.006, 1.6 * v, 3000, 9000, 0.0015);
  bandNoise(b, r, t + 0.008, 0.02, 0.9 * v, 600, 4000, 0.004);
  ring(b, r, t + 0.008, space ? 900 : 1800 + Math.random() * 300, (space ? 0.4 : 0.25) * v, space ? 0.01 : 0.004);
  bandNoise(b, r, t + 0.04, 0.005, 0.45 * v, 3000, 9000, 0.0012);
};
SOUNDS.type = (b, r) => {
  const gap = 0.12;
  let t = 0;
  for (const p of [3, "_", 6, "_", 2]) {                        // letters per word; "_" is the space bar
    if (p === "_") { t += gap * 0.5; keyPress(b, r, t, 1.05, true); t += gap * 1.5; continue; }
    for (let i = 0; i < p; i++) { keyPress(b, r, t, (i === 0 ? 1 : 0.8) + Math.random() * 0.1); t += gap * (0.85 + Math.random() * 0.3); }
  }
  return t + 0.11;
};
SOUNDS.whir = (b, r) => { servo(b, r, 0, 0.35, [110, 170], 0.45); return 0.36; };   // running something: a short soft motor whir

// Web search or browsing: soft satellite telemetry, four low beeps over faint radio static.
SOUNDS.radio = (b, r) => {
  const n = Math.round(1.05 * r);                              // static: noise band-passed 300 Hz to 3 kHz, faded in and out
  noise(b, r, 0, 1.05, { lo: 300, hi: 3000, vol: 0.07, env: (_, k) => Math.min(1, k / (0.04 * r), (n - k) / (0.06 * r)) });
  for (let i = 0; i < 4; i++) tone(b, r, i * 0.25, 0.11, 1050, { wave: "sine", vol: 0.35, att: 0.005, rel: 0.02 });
  return 1.05;
};

// Every sound above, by name: the tags like [beep] that a spoken line can hold.
export const SOUND_NAMES = Object.keys(SOUNDS);
