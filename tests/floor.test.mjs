import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFloor } from '../server/floor.mjs';

// Several "daemons" in one process: fake pids, all alive unless listed in dead.
function setup(run) {
  const home = mkdtempSync(join(tmpdir(), 'vm-floor-'));
  const dead = new Set();
  const floor = pid => createFloor({ home, pid, alive: p => !dead.has(p) });
  return Promise.resolve(run({ home, dead, floor })).finally(() => rmSync(home, { recursive: true, force: true }));
}

test('only one daemon holds the floor', () => setup(async ({ floor }) => {
  const a = floor(101), b = floor(102);
  assert.equal(await a.acquire(), true);
  assert.equal(b.busyElsewhere(), true);
  assert.equal(await b.acquire({ maxWait: 150 }), false);
  a.release();
  assert.equal(await b.acquire({ maxWait: 150 }), true);
  assert.equal(a.busyElsewhere(), true);
}));

test('a message that is no longer wanted stops waiting', () => setup(async ({ floor }) => {
  const a = floor(101), b = floor(102);
  await a.acquire();
  let gone = false;
  setTimeout(() => (gone = true), 100);
  assert.equal(await b.acquire({ gone: () => gone }), false);
  assert.equal(b.held, false);
}));

test('the holder sees others waiting, and someone who needs the user goes first', () => setup(async ({ floor }) => {
  const a = floor(101), routine = floor(102), urgent = floor(103);
  await a.acquire();
  const order = [];
  const r = routine.acquire().then(() => { order.push('routine'); routine.release(); });
  await new Promise(res => setTimeout(res, 50));
  const u = urgent.acquire({ priority: 1 }).then(() => { order.push('urgent'); urgent.release(); });
  await new Promise(res => setTimeout(res, 50));
  assert.equal(a.othersWaiting(), true);
  a.release();
  await Promise.all([r, u]);
  assert.deepEqual(order, ['urgent', 'routine']);
}));

test('a floor left by a dead daemon is taken over', () => setup(async ({ home, dead, floor }) => {
  writeFileSync(join(home, 'floor.lock'), '999');
  dead.add(999);
  assert.equal(await floor(101).acquire({ maxWait: 150 }), true);
}));

test('who spoke last is shared', () => setup(async ({ floor }) => {
  floor(101).spoke('alpha');
  const last = floor(102).lastSpeaker();
  assert.equal(last.label, 'alpha');
  assert(Date.now() - last.at < 1000);
}));
