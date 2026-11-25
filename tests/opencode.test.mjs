import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const home = mkdtempSync(join(tmpdir(), 'vm-oc-'));
process.env.VOICE_MODE_HOME = home;
process.env.VOICE_MODE_NODE = 'true';   // never start a real daemon from a test
const { default: VoiceMode } = await import('../opencode/plugin.mjs');

// A fake daemon socket and a fake OpenCode client. The narrator session answers with a fixed line.
async function fixture(run, { narratorFails = false } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => { calls.push([req.url, body]); res.end(JSON.stringify({ ok: true, sentences: 1 })); });
  });
  await new Promise(r => server.listen(join(home, 'opencode.sock'), r));
  const prompts = [], deleted = [];
  let answer = 'The change is complete. All checks passed.';
  const client = {
    session: {
      create: async () => ({ data: { id: `narr-${prompts.length}` } }),
      prompt: async opts => {
        prompts.push(opts);
        if (narratorFails) throw new Error('no model');
        return { data: { info: {}, parts: [{ type: 'text', text: 'Spoken summary. All good.' }] } };
      },
      delete: async opts => { deleted.push(opts.path.id); return { data: true }; },
      messages: async () => ({ data: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'Fix it' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: answer }] },
      ] }),
    },
  };
  const hooks = await VoiceMode({ client, directory: '/work/my-app' });
  await hooks.config({ small_model: 'anthropic/claude-haiku-5-5' });
  const send = (sessionID, text, model) => hooks['chat.message']({ sessionID, model }, { message: {}, parts: [{ type: 'text', text }] });
  const event = (type, properties) => hooks.event({ event: { type, properties } });
  try { await run({ calls, hooks, send, event, prompts, deleted, setAnswer: a => (answer = a) }); }
  finally { await new Promise(r => server.close(r)); rmSync(join(home, 'opencode-off'), { force: true }); }
}

test('a message gets an acknowledgment, working sounds, and a spoken summary when the session goes idle', () => fixture(async ({ calls, send, event, prompts, deleted }) => {
  await send('s1', 'Fix the issue');
  assert(calls.some(([p]) => p === '/stop?session=s1&label=my-app'));
  assert(calls.some(([p]) => p === '/hum/on'));
  assert(calls.some(([p, t]) => p.startsWith('/say?session=s1') && t.startsWith('[beep] ')));
  await event('session.idle', { sessionID: 's1' });
  assert(calls.some(([p]) => p === '/hum/off'));
  assert(calls.some(([p, t]) => p.startsWith('/say?bare=1&session=s1&label=my-app') && t === 'Spoken summary. All good.'));
  const req = prompts[0];
  assert.deepEqual(req.body.model, { providerID: 'anthropic', modelID: 'claude-haiku-5-5' });
  assert(req.body.system.includes('2-XL'));
  assert(req.body.parts[0].text.includes('The change is complete'));
  assert.deepEqual(deleted, ['narr-0']);
  assert(readFileSync(join(home, 'opencode-narrator.log'), 'utf8').includes('end model=anthropic/claude-haiku-5-5'));
}));

test('a second idle does not repeat the summary; the next turn sees what was said', () => fixture(async ({ calls, send, event, prompts }) => {
  await send('s2', 'Fix it');
  await event('session.idle', { sessionID: 's2' });
  await event('session.idle', { sessionID: 's2' });
  assert.equal(calls.filter(([, t]) => t === 'Spoken summary. All good.').length, 1);
  await send('s2', 'And now?');
  await event('session.idle', { sessionID: 's2' });
  assert(prompts.at(-1).body.parts[0].text.includes('- Spoken summary. All good.'));
}));

test('narrator failure falls back to the first sentences of the answer', () => fixture(async ({ calls, send, event, setAnswer }) => {
  setAnswer('Fixed the sound. Checks passed. More detail here.');
  await send('s3', 'Fix it');
  await event('session.idle', { sessionID: 's3' });
  assert(calls.some(([p, t]) => p.startsWith('/say?bare=1') && t === 'Fixed the sound. Checks passed.'));
}, { narratorFails: true }));

test('permission prompts and questions chime; answering goes back to work', () => fixture(async ({ calls, hooks, send, event }) => {
  await send('s4', 'Deploy');
  await event('permission.updated', { id: 'p1', type: 'bash', sessionID: 's4', title: 'rm', metadata: {} });
  assert(calls.some(([p, t]) => p.startsWith('/wait/start?session=s4') && t.includes('to run a command')));
  await event('permission.replied', { sessionID: 's4', permissionID: 'p1', response: 'once' });
  assert(calls.some(([p]) => p === '/wait/stop'));
  calls.length = 0;
  await hooks['tool.execute.before']({ tool: 'question', sessionID: 's4', callID: 'c1' }, { args: { questions: [{ question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }] } });
  assert(calls.some(([p, t]) => p.startsWith('/wait/start') && t.includes('Which branch? The choices are: main, or dev.')));
}));

test('tool calls set the working sound', () => fixture(async ({ calls, hooks, send }) => {
  await send('s5', 'Look around');
  await hooks['tool.execute.before']({ tool: 'read', sessionID: 's5', callID: 'c1' }, { args: { filePath: '/a' } });
  await hooks['tool.execute.after']({ tool: 'read', sessionID: 's5', callID: 'c1', args: { filePath: '/a' } }, { title: '', output: '', metadata: {} });
  assert(calls.some(([p, t]) => p === '/activity' && t === 'read'));
  assert(calls.some(([p, t]) => p === '/activity' && t === 'think'));
}));

test('subagent and narrator sessions stay silent', () => fixture(async ({ calls, send, event }) => {
  await event('session.created', { info: { id: 'child', parentID: 's6' } });
  await send('child', 'Subtask');
  assert.equal(calls.length, 0);
}));

test('"stop talking" mutes; "you can talk again" unmutes', () => fixture(async ({ calls, send, event }) => {
  await send('s7', 'Stop talking please');
  assert(existsSync(join(home, 'opencode-off')));
  assert(calls.some(([p]) => p === '/mute?click=1&session=s7&label=my-app'));
  assert(!calls.some(([p]) => p.startsWith('/say')));
  calls.length = 0;
  await send('s7', 'Next task');
  await event('session.idle', { sessionID: 's7' });
  assert(!calls.some(([p]) => p.startsWith('/say')));
  await send('s7', 'You can talk again. Next task');
  assert(!existsSync(join(home, 'opencode-off')));
  assert(calls.some(([p, t]) => p.startsWith('/say') && t.startsWith('[beep]')));
}));

test('an aborted turn says nothing more', () => fixture(async ({ calls, send, event }) => {
  await send('s8', 'Long job');
  await event('session.error', { sessionID: 's8', error: { name: 'MessageAbortedError', data: {} } });
  await event('session.idle', { sessionID: 's8' });
  assert(!calls.some(([p, t]) => p.startsWith('/say?bare=1') && t.includes('Spoken')));
}));

test('voice_off and voice_on tools', () => fixture(async ({ hooks }) => {
  await hooks.tool.voice_off.execute({}, { sessionID: 's9' });
  assert(existsSync(join(home, 'opencode-off')));
  await hooks.tool.voice_on.execute({}, {});
  assert(!existsSync(join(home, 'opencode-off')));
}));

test('narrator calls run without thinking; the user\'s chat is untouched', () => fixture(async ({ hooks, send, event }) => {
  const params = sid => { const o = { options: { thinking: { type: 'enabled' } }, maxOutputTokens: 32000 };
    return hooks['chat.params']({ sessionID: sid, model: { api: { npm: '@ai-sdk/openai-compatible' } } }, o).then(() => o); };
  const user = await params('s10');
  assert.equal(user.options.chat_template_kwargs, undefined);
  assert.equal(user.maxOutputTokens, 32000);
  await send('s10', 'Fix it');
  await event('session.idle', { sessionID: 's10' });
  const narr = await params('narr-0');
  assert.deepEqual(narr.options.chat_template_kwargs, { enable_thinking: false });
  assert.equal(narr.maxOutputTokens, 400);
}));

test.after(() => rmSync(home, { recursive: true, force: true }));
