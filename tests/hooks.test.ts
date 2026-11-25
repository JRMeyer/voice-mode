import { test, expect, mock } from 'claude-code/testing'

// A store the test can read back: the plugin's $.store calls land here.
function memStore(on: any, seed: Record<string, unknown> = {}) {
  const m = new Map<string, unknown>(Object.entries(seed))
  on('store.get', ((_: unknown, e: { key: string }) => ({ value: m.get(e.key) })) as never)
  on('store.set', ((_: unknown, e: { key: string; value: unknown }) => { m.set(e.key, e.value); return { value: undefined } }) as never)
  on('store.delete', ((_: unknown, e: { key: string }) => { m.delete(e.key); return { value: undefined } }) as never)
  on('store.keys', (() => ({ value: [...m.keys()] })) as never)
  return m
}

// The session starts as under the engine, with no daemon: the spawn is refused and the restart loop waits on the
// test's clock. Each post to the daemon is recorded as [path, body]. done() runs the loop out (five tries, a second
// apart), so nothing of it is still asleep when the test unloads the plugin.
async function start($: any, on: any) {
  const clock = mock.clock(on)
  const posts: [string, string][] = []
  on('process.hookEnv', (() => ({ value: { CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_PLUGIN_DATA: '/d', CLAUDE_CODE_SESSION_ID: 'abcdefgh-1234' } })) as never)
  on('process.spawn', (async function* () { return { deny: 'no daemon in tests' } }) as never)
  on('ui.log', (() => ({ value: undefined })) as never)
  on('ui.status', (() => ({ value: undefined })) as never)
  on('fs.write', (() => ({ value: undefined })) as never)
  on('command.register', ((_: unknown, e: { name: string }) => ({ value: { command: e.name } })) as never)
  on('http.fetch', ((_: unknown, e: { url: string; init?: { body?: string } }) => {
    posts.push([e.url.replace('http://voice-mode', ''), String(e.init?.body ?? '')])
    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  }) as never)
  on('session.start', (() => ({ cwd: '/w' })) as never)
  on('session.end', (() => ({ sessionId: 'abcdefgh' })) as never)
  on('classic.PermissionRequest', (() => ({})) as never)
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
  return { clock, posts, done: () => clock.advance(5000) }
}

test('the hooks module loads shared/narration.mjs in the sandbox', async ($, on) => {
  const store = memStore(on)
  on('ui.status', (() => ({ value: undefined })) as never)
  const r = (await ($ as any).command.run({ command: 'voice-mode', args: 'off' })) as { text?: string }
  expect(r.text).toBe('Voice off. Claude will reply in text only.')
  expect(store.get('off')).toBe(true)
})

test('session end on exit drops this session’s two keys and keeps the rest', async ($, on) => {
  const store = memStore(on, { off: true, welcomed: true })
  const { done } = await start($, on)
  expect(typeof store.get('owner-abcdefgh')).toBe('string')
  store.set('turn-abcdefgh', { id: 't1' })
  await ($ as any).session.end({ reason: 'prompt_input_exit' })
  expect([...store.keys()].sort()).toEqual(['off', 'welcomed'])
  await done()
})

test('session end keeps the keys of a process that resumed this session meanwhile', async ($, on) => {
  const store = memStore(on)
  const { done } = await start($, on)
  store.set('owner-abcdefgh', 'other')
  store.set('turn-abcdefgh', { id: 't2' })
  await ($ as any).session.end({ reason: 'prompt_input_exit' })
  expect([...store.keys()].sort()).toEqual(['owner-abcdefgh', 'turn-abcdefgh'])
  expect(store.get('owner-abcdefgh')).toBe('other')
  await done()
})

test('session end after a /clear keeps the keys', async ($, on) => {
  const store = memStore(on)
  const { done } = await start($, on)
  store.set('turn-abcdefgh', { id: 't1' })
  await ($ as any).session.end({ reason: 'clear' })
  expect([...store.keys()].sort()).toEqual(['owner-abcdefgh', 'turn-abcdefgh'])
  await done()
})

test('a permission dialog still open after 1.5 s starts the chime', async ($, on) => {
  memStore(on)
  const { clock, posts, done } = await start($, on)
  await ($ as any).classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'make' } })
  await clock.advance(1400)
  expect(posts.map(p => p[0])).toEqual([])
  await clock.advance(100)
  expect(posts.map(p => p[0])).toEqual(['/wait/start'])
  await done()
})

test('voice off cancels a permission chime still pending', async ($, on) => {
  memStore(on)
  const { clock, posts, done } = await start($, on)
  await ($ as any).classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'make' } })
  await ($ as any).command.run({ command: 'voice-mode', args: 'off' })
  await clock.advance(1500)
  expect(posts.map(p => p[0])).toEqual(['/mute'])
  await done()
})

test('after voice off, the end of a wait does not restart the working sound', async ($, on) => {
  memStore(on, { welcomed: true })
  on('model.complete', (() => ({ value: { isAnswered: false, reason: 'no model in tests' } })) as never)
  on('turn.start', ((_: unknown, e: { turnId: string }) => ({ turnId: e.turnId })) as never)
  on('tool.run', (() => ({ result: 'ok' })) as never)
  const { clock, posts, done } = await start($, on)
  await ($ as any).turn.start({ turnId: 't1', text: 'Fix the build' })
  await ($ as any).classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'make' } })
  await clock.advance(1500)
  await ($ as any).command.run({ command: 'voice-mode', args: 'off' })
  await ($ as any).tool.run({ tool: 'Bash', command: 'make' })
  await clock.settle()
  expect(posts.map(p => p[0])).toEqual(['/hum/on', '/wait/start', '/mute'])
  await done()
})

test('compacting the main conversation plays the trash compactor; a precompute or a subagent does not', async ($, on) => {
  memStore(on, { welcomed: true })
  const messages = [{ role: 'user', text: 'summary', toolUses: [] }]
  on('session.compact', (() => ({ messages })) as never)
  const { posts, done } = await start($, on)
  await ($ as any).session.compact({ trigger: 'precompute', messages })
  await ($ as any).session.compact({ trigger: 'auto', agentId: 'a1', messages })
  expect(posts.filter(([, b]) => b === '[compact]')).toEqual([])
  await ($ as any).session.compact({ trigger: 'manual', messages })
  expect(posts.filter(([, b]) => b === '[compact]')).toEqual([['/say?bare=1', '[compact]']])
  await done()
})
