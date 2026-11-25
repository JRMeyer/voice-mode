import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { mute } from '../server/client.mjs';

// A fake daemon on a short socket path (Unix socket paths max out near 104 bytes), a new one each time: Node keeps
// connections open for reuse, and one to a closed server fails. old: a 0.5.7 daemon, which has no /mute.
let n = 0;
async function daemon(run, { old = false } = {}) {
  const sock = `/tmp/vmt${process.pid}-${++n}.sock`, calls = [];
  rmSync(sock, { force: true });
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      calls.push([req.url, body]);
      res.end(JSON.stringify(old && req.url.startsWith('/mute') ? { ok: false, error: 'unknown path' } : { ok: true, sentences: 1 }));
    });
  });
  await new Promise(r => server.listen(sock, r));
  try { await run(sock, calls); } finally { await new Promise(r => server.close(r)); }
}

test('mute is one request to a current daemon', () => daemon(async (sock, calls) => {
  assert.equal((await mute(sock, { click: true })).ok, true);
  assert.deepEqual(calls, [['/mute?click=1', '']]);
}));

test('a 0.5.7 daemon is silenced through the calls it knows, the click last', () => daemon(async (sock, calls) => {
  assert.equal((await mute(sock, { click: true })).ok, true);
  assert.deepEqual(calls.map(([p]) => p), ['/mute?click=1', '/stop', '/wait/stop', '/hum/off', '/say?bare=1']);
  assert.equal(calls.at(-1)[1], '[click]');
  calls.length = 0;
  assert.equal((await mute(sock)).ok, true);
  assert.deepEqual(calls.map(([p]) => p), ['/mute', '/stop', '/wait/stop', '/hum/off']);
}, { old: true }));
