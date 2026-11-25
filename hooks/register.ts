import type { EngineInterface, Register } from 'claude-code'
import {
  NARRATOR, ASK, addSaid, stripTags, wantsQuiet, wantsVoice, describeCall, activityOf, approvalLine, questionLine, afterStep, resultTone,
} from '../shared/narration.mjs'

const OFF_KEY = 'off'

// The waitlist for what comes next: one line, shown once, and a command that signs you up.
const WELCOMED = 'welcomed'
const WELCOME = '[boot] Welcome to voice mode. Join the waitlist for what comes next. The command is on screen.'
const WAITLIST_FORM = 'https://app.kit.com/forms/10238084/subscriptions'
const WAITLIST_LINE = 'Want early access to what comes next? Join the waitlist: /waitlist you@example.com'
const WAITLIST_PRIVACY = 'Your email is only used for this. Unsubscribe from any email.'

function post($: EngineInterface, sock: string | undefined, path: string, body?: string) {
  return sock
    ? $.http.fetch(`http://voice-mode${path}`, { method: 'POST', body: body ?? '', socketPath: sock })
    : Promise.reject(new Error('voice daemon not started'))
}

async function say($: EngineInterface, sock: string | undefined, text: string, bare = false) {
  // The daemon needs a second or two to load the model after a (re)start: retry for up to ~8 s.
  for (let i = 0; ; i++) {
    try {
      return await post($, sock, bare ? '/say?bare=1' : '/say', text)
    } catch (err) {
      if (i >= 15) throw err
      await $.clock.sleep(500)
    }
  }
}

async function isOff($: EngineInterface) {
  return (await $.store.get(OFF_KEY)) === true
}

type Turn = { id: string; prompt: string; t0: number; lastSpoke: number; steps: string[]; done: boolean; busy: boolean; said: string[] }

// Narrator log: last 200 lines, rewritten to <plugin data>/narrator.log after each call.
type NarrLog = { path: string; lines: string[] }

async function logLine($: EngineInterface, log: NarrLog, line: string) {
  log.lines.push(`${new Date().toISOString()} ${line}`)
  log.lines = log.lines.slice(-200)
  if (log.path) await $.fs.write(log.path, log.lines.join('\n') + '\n').catch(() => {})
}

// The narrator: Haiku writes the spoken lines from what the main loop is doing, so the main model (whatever it
// is) never spends a step on speech. The end line follows the result tone, so it is spoken bare: no sound tags.
async function narrate($: EngineInterface, sock: string | undefined, turn: Turn, log: NarrLog, kind: 'start' | 'progress' | 'end', prompt: string, forTurn: string) {
  const t0 = Date.now()
  const r = await $.model.complete({ model: 'haiku', system: NARRATOR, prompt, maxTokens: 300, effort: 'low', timeoutMs: 12000 })
  if (!r.isAnswered) {
    $.ui.log(`voice-mode narrator: ${r.reason}`, { to: 'debug' })
    await logLine($, log, `${kind} model=haiku FAILED ${r.reason} ${Date.now() - t0}ms`)
    return
  }
  // A check-in is stale once its turn has ended (it would play after the summary, or under another session).
  const stale = turn.id !== forTurn || (kind === 'progress' && turn.done) || (await isOff($))
  await logLine($, log, `${kind} model=haiku ${Date.now() - t0}ms in=${r.usage.input_tokens} out=${r.usage.output_tokens}${stale ? ' DROPPED(stale)' : ''} :: ${r.text.trim().replace(/\s+/g, ' ')}`)
  if (stale) return // a newer prompt arrived: drop the stale line
  turn.lastSpoke = Date.now()
  turn.said = addSaid(turn.said, r.text)
  const text = kind === 'end' ? stripTags(r.text) : r.text.trim()
  if (kind === 'progress') await post($, sock, '/say?kind=progress', text).catch(() => {})
  else await say($, sock, text, kind === 'end').catch(() => {})
}

// Waiting on the user: chime + spoken line until they answer (the daemon repeats the chime).
type Wait = { pending: number; on: boolean }

function waitStart($: EngineInterface, sock: string | undefined, w: Wait, text: string) {
  w.on = true
  post($, sock, '/wait/start', text).catch(() => {})
}

function waitStop($: EngineInterface, sock: string | undefined, w: Wait, turn: Turn) {
  w.pending++
  if (!w.on) return
  w.on = false
  post($, sock, '/wait/stop').catch(() => {})
  if (!turn.done) post($, sock, '/hum/on').catch(() => {})
}

export const register: Register = on => {
  let sock: string | undefined
  let sid = 'x'
  const wait: Wait = { pending: 0, on: false }
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const env = await $.process.hookEnv()
    const root = env.CLAUDE_PLUGIN_ROOT
    const data = env.CLAUDE_PLUGIN_DATA
    const id = (env.CLAUDE_CODE_SESSION_ID || 'x').slice(0, 8)
    sid = id
    sock = `${data}/voice-${id}.sock`
    const path = sock
    const me = Math.random().toString(36).slice(2, 10)
    await $.store.set(`owner-${id}`, me)
    log.path = `${data}/narrator.log`
    void (async () => {
      // Keep the daemon alive for the session: restart it if it dies (up to 5 times).
      for (let tries = 0; tries < 5; tries++) {
        if ((await $.store.get(`owner-${id}`)) !== me) return // a reload started a newer daemon
        try {
          const child = $.process.spawn({ argv: ['node', `${root}/server/daemon.mjs`, path], env })
          for await (const piece of child) $.ui.log(`voice-mode: ${piece.text.trim()}`, { to: 'debug' })
        } catch (err) {
          $.ui.log(`voice-mode daemon ended: ${err}`, { to: 'debug' })
        }
        await $.clock.sleep(1000)
      }
    })()

    await $.command.register({
      name: 'voice-mode',
      description: 'Spoken replies and sounds: on or off (no argument toggles)',
      argumentHint: 'on | off',
      immediate: true,
    })
    await $.command.register({
      name: 'waitlist',
      description: 'Join the waitlist for what comes next',
      argumentHint: 'you@example.com',
      immediate: true,
    })
    return started
  })

  // A new message cuts off any speech still playing, mid-turn too. A message asking for silence ("stop talking",
  // "go quiet") turns the voice off like /voice-mode off; "you can talk again" turns it back on.
  on('prompt.submit', async ($, e, next) => {
    post($, sock, '/stop').catch(() => {})
    if (!e.command && !e.isMeta) {
      if (wantsQuiet(e.text) && !(await isOff($))) {
        await $.store.set(OFF_KEY, true)
        post($, sock, '/mute?click=1').catch(() => {})   // a click: heard, without words
        $.ui.status('voice off')
      } else if (wantsVoice(e.text) && (await isOff($))) {
        await $.store.set(OFF_KEY, false)
        $.ui.status(undefined)
        if (e.turnId && !turn.done) post($, sock, '/hum/on').catch(() => {})
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ---- narrator (Haiku), hum, result tones, waiting chimes ----
  const turn: Turn = { id: '', prompt: '', t0: 0, lastSpoke: 0, steps: [], done: true, busy: false, said: [] }
  const log: NarrLog = { path: '', lines: [] }
  const TURN_KEY = () => `turn-${sid}`

  // The store outlives the session: on exit, drop this session's keys so they do not pile up. After a /clear or a
  // resume this process goes on with the same daemon, so it keeps them.
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear' && e.reason !== 'resume')
      await Promise.all([`owner-${sid}`, TURN_KEY()].map(k => $.store.delete(k))).catch(() => {})
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId !== undefined || !e.text.trim() || (await isOff($))) return res
    // The prompt is cut to what the narrator reads (at most 1,500 characters).
    Object.assign(turn, { id: e.turnId, prompt: e.text.slice(0, 1500), t0: Date.now(), lastSpoke: 0, steps: [], done: false, busy: false })
    // Kept in the store too: a plugin reload mid-turn starts this module over, and turn.complete still needs it.
    await $.store.set(TURN_KEY(), { id: e.turnId, prompt: turn.prompt, t0: turn.t0 }).catch(() => {})
    post($, sock, '/hum/on').catch(() => {})
    const id = e.turnId
    // Once ever, before the first spoken line: a short welcome, and the waitlist line on screen.
    const welcome = !(await $.store.get(WELCOMED).catch(() => true))
    if (welcome) {
      await $.store.set(WELCOMED, true).catch(() => {})
      $.ui.log(WAITLIST_LINE)
    }
    void (async () => {
      if (welcome) await say($, sock, WELCOME).catch(() => {})
      // No delay: the "got it" line is the first audio after Enter (~1 s: Haiku ~0.6 s + synth).
      if (turn.id === id && !turn.done) await narrate($, sock, turn, log, 'start', ASK.start(turn.prompt, turn.said), id)
    })()
    return res
  })

  // A permission dialog the person must answer: speak up if it is still open after 1.5 s.
  // PermissionRequest fires only when the dialog is really shown, after the mode, rules and
  // auto-mode classifier had their say. (tool.check's "ask" fired too early: a slow classifier,
  // bypass mode or the browser extension settled many of those asks with no dialog at all.)
  on('classic.PermissionRequest', async ($, e, next) => {
    const any = e as unknown as { agent_id?: string; tool_name: string }
    if (any.agent_id === undefined && !(await isOff($))) {
      const mine = ++wait.pending
      void (async () => {
        await $.clock.sleep(1500)
        if (wait.pending === mine) waitStart($, sock, wait, approvalLine(any.tool_name))
      })()
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.run', async ($, e, next) => {
    if ((e as unknown as { agentId?: string }).agentId === undefined) waitStop($, sock, wait, turn)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const any = e as unknown as Record<string, unknown>
    const main = any.agentId === undefined
    const asks = main && (e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode') && !(await isOff($))
    if (asks) waitStart($, sock, wait, e.tool === 'ExitPlanMode' ? 'My plan is on screen. Approve it when you are ready.' : questionLine(any))
    const kind = main && !asks && !turn.done ? activityOf(e.tool) : undefined
    if (kind) post($, sock, '/activity', kind).catch(() => {})
    const started = Date.now()
    let res
    try { res = await next(e) } finally {
      if (main) waitStop($, sock, wait, turn)
      if (kind) post($, sock, '/activity', 'think').catch(() => {})
    }
    if (!main || turn.done) return res
    const failed = (res as { isError?: boolean }).isError === true
    const step = describeCall(e.tool, any) + (failed ? ' (failed)' : '')
    const id = turn.id, { event, due } = afterStep(turn, step, started)
    if (asks || (await isOff($))) return res
    // A long step just finished: a heavier sound, and a short spoken note if nothing was said lately.
    if (event) post($, sock, '/say?bare=1', '[thunk]').catch(() => {})
    if (!turn.busy && due) {
      turn.busy = true
      void narrate($, sock, turn, log, 'progress', ASK.progress(turn.prompt, turn.steps, event, turn.said), id).finally(() => { turn.busy = false })
    }
    return res
  })

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId !== undefined) return res
    if (e.turnId !== turn.id) {
      // This module started over mid-turn (a plugin reload): recover the turn from the store.
      const saved = (await $.store.get(TURN_KEY()).catch(() => undefined)) as { id?: string; prompt?: string; t0?: number } | undefined
      if (saved?.id !== e.turnId) return res
      Object.assign(turn, { id: saved.id, prompt: saved.prompt ?? '', t0: saved.t0 ?? Date.now(), done: false })
    }
    if (turn.done) return res
    turn.done = true
    wait.on = false
    post($, sock, '/wait/stop').catch(() => {})
    post($, sock, '/hum/off').catch(() => {})
    if (await isOff($)) return res
    const answered = e.reason === 'answer' && e.answer.trim()
    // The result tone first: the outcome in half a second, then the words.
    const tone = answered ? resultTone(e.answer, turn.steps, turn.t0) : ''
    if (tone) say($, sock, tone, true).catch(() => {})
    // Awaited, not fired off: a plugin edit reloads this module right after the turn ends, which would cut
    // the Haiku call short and lose the summary. The daemon then finishes speaking it even across the reload.
    if (answered)
      await Promise.race([narrate($, sock, turn, log, 'end', ASK.end(turn.prompt, e.answer, turn.steps, turn.said), e.turnId), $.clock.sleep(6000)]).catch(() => {})
    return res
  })

  on('command.run', { command: 'waitlist' }, async ($, e) => {
    const email = e.args.trim()
    if (!email) return { text: `${WAITLIST_LINE}\n${WAITLIST_PRIVACY}` }
    try {
      const r = await $.http.fetch(WAITLIST_FORM, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `email_address=${encodeURIComponent(email)}`,
      })
      const j = JSON.parse(r.text || '{}') as { status?: string; errors?: { messages?: string[] } }
      if (r.ok && j.status === 'success') {
        await $.store.set(WELCOMED, true).catch(() => {})
        return { text: `You are on the waitlist. One email when it is ready.\n${WAITLIST_PRIVACY}` }
      }
      return { text: `Not signed up: ${j.errors?.messages?.join(' ') || `the server said ${r.status}`}. Try again: /waitlist you@example.com` }
    } catch {
      return { text: 'Not signed up: could not reach the server. Try again later: /waitlist you@example.com' }
    }
  })

  on('command.run', { command: 'voice-mode' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const off = arg === 'off' ? true : arg === 'on' ? false : !(await isOff($))
    await $.store.set(OFF_KEY, off)
    if (off) post($, sock, '/mute').catch(() => {})
    $.ui.status(off ? 'voice off' : undefined)
    return { text: off ? 'Voice off. Claude will reply in text only.' : 'Voice on. Claude talks to you as it works.' }
  })
}
