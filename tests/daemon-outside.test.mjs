import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, symlinkSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { post } from '../server/client.mjs';

// The real daemon, with a fake player (tests/fake-player.mjs) that records what it was given and plays in real
// time, and a fake clip: /bin/sleep run through a link named afplay, which ps shows as afplay.
const ROOT = new URL('..', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'vmo-'));
const sock = `/tmp/vmo${process.pid}.sock`;
const out = join(dir, 'out');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let daemon;

const logText = () => { try { return readFileSync(`${sock}.log`, 'utf8'); } catch { return ''; } };
const count = re => (logText().match(new RegExp(re.source, 'g')) || []).length;
async function until(check, ms = 15000) {
  const t0 = Date.now();
  while (!check()) { if (Date.now() - t0 > ms) throw new Error(`timed out; log:\n${logText()}`); await sleep(50); }
}
// A clip that plays for ms. Resolves when it is over.
function clip(ms) {
  const p = spawn(join(dir, 'afplay'), [String(ms / 1000)], { stdio: 'ignore' });
  return new Promise(r => p.on('exit', r));
}
// What each player was given, oldest first.
const played = () => readdirSync(out).map(f => join(out, f)).sort((a, b) => statSync(a).birthtimeMs - statSync(b).birthtimeMs).map(f => readFileSync(f));
// Everything said and done: nothing queued and no player left.
const idle = async () => { for (;;) { if ((await post(sock, '/health')).queued === 0 && count(/player started/) === count(/player exit/)) return; await sleep(100); } };

before(async () => {
  symlinkSync('/bin/sleep', join(dir, 'afplay'));
  rmSync(sock, { force: true }); rmSync(`${sock}.log`, { force: true });
  spawn('mkdir', ['-p', out]).on('exit', () => {});
  await sleep(100);
  daemon = spawn(process.execPath, [join(ROOT, 'server/daemon.mjs'), sock], {
    stdio: 'ignore',
    env: { ...process.env, VOICE_MODE_PLAYER: join(ROOT, 'tests/fake-player.mjs'), VOICE_MODE_HOME: join(dir, 'home'), VOICE_MODE_TEST_OUT: out, VOICE_MODE_LABEL: 'test' },
  });
  await until(() => existsSync(sock) && /ready on/.test(logText()), 30000);
});

after(async () => {
  daemon?.kill();
  await sleep(200);
  rmSync(dir, { recursive: true, force: true });
  rmSync(sock, { force: true }); rmSync(`${sock}.log`, { force: true });
});

test('speech waits for a clip that is already playing, then plays', async () => {
  const players = count(/player started/);
  const done = clip(1500);
  await sleep(300);
  await post(sock, '/say', 'Here is the summary.');
  await until(() => count(/hold for outside audio/) >= 1);
  assert.equal(count(/player started/), players, 'no player while the clip plays');
  await done;
  await until(() => count(/player started/) > players);
  await idle();
});

test('a clip that starts mid-sentence cuts the voice, which says that sentence again after it', async () => {
  const cuts = count(/cut for outside audio; again: [1-9]/), before = played().length;
  await post(sock, '/say', 'This is the first sentence of a longer summary. Here is a second sentence to keep talking. And a third one, so there is more to say.');
  await until(() => count(/player started/) > 0 && played().length > before);
  await sleep(1200);
  const done = clip(1000);
  await until(() => count(/cut for outside audio; again: [1-9]/) > cuts);
  await done;
  await idle();
  const [first, ...rest] = played().slice(before);
  assert.ok(rest.length >= 1, 'a new player after the clip');
  const again = rest.at(-1).subarray(0, 4800);
  assert.ok(again.length === 4800 && first.includes(again), 'it opens with audio the cut player already had: the sentence again');
});

test('/stop while held behind a clip drops what was waiting', async () => {
  const players = count(/player started/);
  const done = clip(1200);
  await sleep(300);
  const holds = count(/hold for outside audio/);
  await post(sock, '/say', 'You should never hear this.');
  await until(() => count(/hold for outside audio/) > holds);
  await post(sock, '/stop');
  await done;
  await sleep(800);
  assert.equal(count(/player started/), players);
});

test('a "needs you" line held behind a clip is dropped once the person answers', async () => {
  const players = count(/player started/);
  const done = clip(1200);
  await sleep(300);
  await post(sock, '/wait/start', 'Approve the command.');
  await sleep(400);
  await post(sock, '/wait/stop');
  await done;
  await sleep(800);
  assert.equal(count(/player started/), players);
});

test('a working sound is skipped while a clip plays', async () => {
  const players = count(/player started/);
  const done = clip(1200);
  await sleep(300);
  await post(sock, '/hum/on');
  await post(sock, '/activity', 'read');
  await sleep(500);
  await post(sock, '/hum/off');
  await done;
  await sleep(500);
  assert.equal(count(/player started/), players);
  assert.equal((await post(sock, '/health')).queued, 0);
});
