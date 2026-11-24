import type { EngineInterface, Register } from 'claude-code'

const OFF_KEY = 'off'

// The waitlist for what comes next: one line, shown once, and a command that signs you up.
const WELCOMED = 'welcomed'
const WELCOME = '[boot] Welcome to voice mode. Join the waitlist for what comes next. The command is on screen.'
const WAITLIST_FORM = 'https://app.kit.com/forms/10238084/subscriptions'
const WAITLIST_LINE = 'Want early access to what comes next? Join the waitlist: /waitlist you@example.com'
const WAITLIST_PRIVACY = 'Your email is only used for this. Unsubscribe from any email.'

// The narrator: Haiku writes the spoken lines from what the main loop is doing, so the
// main model (whatever it is) never spends a step on speech.
const NARRATOR = `You are the spoken voice of a coding assistant, a friendly 1980s toy robot like 2-XL.
You turn what the assistant is doing into speech for the user, who is listening, not reading.
Never use contractions in spoken text: say "it is", "cannot", "will not", "I am", "do not", "that is", never "it's", "can't", "won't", "I'm", "don't", "that's".
Rules: short clipped sentences, a few words each, simple terse robot grammar, facts exact (keep numbers, names and times as given; never invent any).
Never read out paths, URLs, code, commands, symbols, tables or lists.
Sounds, sparingly: begin with one sound tag; at most one more, only for a real result ([success] or [error]). Tags: [beep] [boop] [click] [servo] [think] [success] [error] [boot].
Reply with the spoken line only, no quotes, no preamble. Keep within the word limit the request gives.`

// Earlier spoken lines, so the narrator says only what is new. Mirrors codex/lib.mjs.
const SAID = (said: string[]) => said.length
  ? `What you already said to the user earlier in this conversation (oldest first):\n${said.map(x => `- ${x}`).join('\n')}\nThe user heard all of that. Never say it again, not even reworded: no repeated acknowledgments, plans, check-in intervals or results. Say only what is new.\n`
  : ''

const ASK = {
  start: (prompt: string) =>
    `The user just asked:\n<<<${prompt.slice(0, 1500)}>>>\nAcknowledge it in at most eight words, like "Got it. On it." or "Query received. Working." You know NOTHING yet about the answer, the status, or what has been done: never state or guess any progress, results, numbers, or plans, and never answer the question.`,
  progress: (prompt: string, steps: string[], event?: string) =>
    `The user asked:\n<<<${prompt.slice(0, 600)}>>>\nRecent steps (oldest first):\n${steps.join('\n')}\n${event ? `What just happened: ${event}\nTell the user about that in one or two short sentences, at most 25 words, plainly saying whether it went well.` : 'Give a short progress check-in: what is happening now, at most 25 words.'} Do not reply to the user's request itself; it was already acknowledged. If nothing new happened since your last line, say only a few words, like "Still working." Do not announce a final answer.`,
  end: (prompt: string, answer: string, steps: string[] = []) =>
    `The user asked:\n<<<${prompt.slice(0, 600)}>>>\n${steps.length >= 3 ? `The assistant worked through ${steps.length} or more steps, the last ones:\n${steps.slice(-8).join('\n')}\n` : ''}The assistant's written answer:\n<<<${answer.slice(0, 6000)}>>>\nYou are talking WITH the user in a conversation, not reading the answer aloud. The user does not read the screen, so tell them what they'd want to hear, the way a sharp colleague would say it out loud: the point first, then only the one or two facts that matter, then the question or next step if there is one. If the assistant worked through several steps, open with one short sentence saying what it did, in plain words (for example "I added the new sounds and pushed them."), so the user is never left wondering what happened. Two to five sentences, at most 70 words. Leave out identifiers nobody says aloud: commit hashes, repo or file names, paths, IDs, flags, exact version strings, long lists. Round numbers the way people speak them. Don't recap everything that was done. Only when the answer contains something meant to be looked at (a table, a code block, a command), mention it once in a few words, e.g. "The table is on screen." A result tone has already played: use no sound tags in this line.`,
}

const describeCall = (e: Record<string, unknown>) => {
  const pick = ['description', 'command', 'file_path', 'pattern', 'query', 'prompt', 'url']
    .map(k => e[k]).find(v => typeof v === 'string' && v) as string | undefined
  return `${String(e.tool).replace(/^mcp__/, '')}: ${(pick ?? '').replace(/\s+/g, ' ').slice(0, 160)}`
}

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

// Asking in plain words for silence, or for the voice back. Mirrors codex/lib.mjs: keep them in sync.
// "stop talking to the server" is about code, not the voice: talking/speaking followed by "to the/a/an" does not count.
const HUSH = /\b(stop|quit|no more|enough) (talking|speaking|narrating|narration|chattering)\b(?! to (the|a|an)\b)|\b(go|be|stay|keep) (quiet|silent)\b|\bshut up\b|\b(mute|silence) (yourself|the voice|voice|it)\b|\bvoice( mode)? off\b|^\W*(mute|silence|quiet|hush|shh+)\W*$/i
const UNHUSH = /\b(you can|you may|feel free to|ok(ay)? to) (talk|speak)\b|\b(start|resume) (talking|speaking)\b|\bvoice( mode)? on\b|\bunmute\b|\btalk to me again\b/i
const wantsQuiet = (text: string) => HUSH.test(text)
const wantsVoice = (text: string) => UNHUSH.test(text)

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

async function narrate($: EngineInterface, sock: string | undefined, turn: Turn, log: NarrLog, kind: string, ask: string, forTurn: string, bare = false) {
  const t0 = Date.now()
  const r = await $.model.complete({ model: 'haiku', system: NARRATOR, prompt: SAID(turn.said) + ask, maxTokens: 300, effort: 'low', timeoutMs: 12000 })
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
  turn.said = [...turn.said, r.text.replace(/\[[a-z]+\]/gi, ' ').replace(/\s+/g, ' ').trim()].slice(-10)
  const text = bare ? r.text.replace(/\[[a-z]+\]/gi, ' ').trim() : r.text.trim()
  if (kind === 'progress') await post($, sock, bare ? '/say?bare=1&kind=progress' : '/say?kind=progress', text).catch(() => {})
  else await say($, sock, text, bare).catch(() => {})
}


// What to say when the user has to answer something on screen.
function questionLine(input: unknown): string {
  const qs = ((input as { questions?: { question?: string; options?: { label?: string }[] }[] })?.questions ?? []).slice(0, 2)
  if (!qs.length) return 'I have a question for you on screen.'
  const one = (q: { question?: string; options?: { label?: string }[] }) => {
    const opts = (q.options ?? []).map(o => o.label).filter(Boolean) as string[]
    const list = opts.length > 1 ? ` The choices are: ${opts.slice(0, -1).join(', ')}, or ${opts[opts.length - 1]}.` : ''
    return `${(q.question ?? '').replace(/\s+/g, ' ').trim()}${list}`
  }
  return `${qs.length > 1 ? 'Two questions on screen. ' : 'Question on screen. '}${qs.map(one).join(' Next. ')}`
}

// Web search, fetching a page, or driving a browser (Claude in Chrome, Playwright and similar MCP tools).
const WEB = /^(WebFetch|WebSearch)$|^mcp__.*(chrome|browser|playwright|puppeteer)/i

// What kind of work a tool call is, for the "still working" sound.
function activityOf(tool: string): 'read' | 'write' | 'run' | 'web' {
  if (WEB.test(tool)) return 'web'
  if (/^(Read|Grep|Glob|LS|NotebookRead|ToolSearch|ListMcpResourcesTool|ReadMcpResourceTool)$/.test(tool)) return 'read'
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return 'write'
  return 'run'
}

function approvalLine(tool: string): string {
  const what = tool === 'Bash' ? 'to run a command'
    : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) ? 'to change a file'
    : /^(WebFetch|WebSearch)$/.test(tool) || /^mcp__/.test(tool) ? 'to use an outside tool' : 'for the next step'
  return `I need your approval ${what}. It is on screen.`
}

// Did the turn go badly? The first lines of the answer say so, or the last steps failed.
function wentBadly(answer: string, steps: string[]): boolean {
  const head = answer.slice(0, 400)
  if (/\b(fail(s|ed|ing)?|error|broken|broke|could ?n[o']t|can ?n[o']t|did ?n[o']t work|does ?n[o']t work|not working|blocked|crash(ed|es)?)\b/i.test(head)
    && !/\b(fixed|works now|passed|resolved)\b/i.test(head)) return true
  return steps.slice(-2).length === 2 && steps.slice(-2).every(x => x.endsWith('(failed)'))
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
        post($, sock, '/wait/stop').catch(() => {})
        post($, sock, '/hum/off').catch(() => {})
        post($, sock, '/say?bare=1', '[click]').catch(() => {})   // heard, without words
        $.ui.status('voice off')
      } else if (wantsVoice(e.text) && !wantsQuiet(e.text) && (await isOff($))) {
        await $.store.set(OFF_KEY, false)
        $.ui.status(undefined)
        if (e.turnId && !turn.done) post($, sock, '/hum/on').catch(() => {})
      }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  // ---- narrator (Haiku), hum, result tones, waiting chimes ----
  const turn: Turn = { id: '', prompt: '', t0: 0, lastSpoke: 0, steps: [], done: true, busy: false, said: [] }
  const log: NarrLog = { path: '', lines: [] }
  const TURN_KEY = () => `turn-${sid}`

  on('turn.start', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId !== undefined || !e.text.trim() || (await isOff($))) return res
    Object.assign(turn, { id: e.turnId, prompt: e.text, t0: Date.now(), lastSpoke: 0, steps: [], done: false, busy: false })
    // Kept in the store too: a plugin reload mid-turn starts this module over, and turn.complete still needs it.
    await $.store.set(TURN_KEY(), { id: e.turnId, prompt: e.text, t0: turn.t0 }).catch(() => {})
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
      if (turn.id === id && !turn.done) await narrate($, sock, turn, log, 'start', ASK.start(turn.prompt), id)
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
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

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
    const step = describeCall(any) + (failed ? ' (failed)' : '')
    turn.steps.push(step)
    turn.steps = turn.steps.slice(-12)
    const now = Date.now(), id = turn.id, took = Math.round((now - started) / 1000)
    if (asks || (await isOff($))) return res
    // A long step just finished: a heavier sound, and a short spoken note if nothing was said lately.
    const event = took >= 30 ? `${step} (took ${took} seconds)` : undefined
    if (event) post($, sock, '/say?bare=1', '[thunk]').catch(() => {})
    const quiet = now - Math.max(turn.lastSpoke, turn.t0)
    const due = event ? quiet > 45000 : now - turn.t0 > 45000 && quiet > 120000
    if (!turn.busy && due) {
      turn.busy = true
      void narrate($, sock, turn, log, 'progress', ASK.progress(turn.prompt, turn.steps, event), id).finally(() => { turn.busy = false })
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
    if (answered && Date.now() - turn.t0 > 8000) say($, sock, wentBadly(e.answer, turn.steps) ? '[error]' : '[success]', true).catch(() => {})
    // Awaited, not fired off: a plugin edit reloads this module right after the turn ends, which would cut
    // the Haiku call short and lose the summary. The daemon then finishes speaking it even across the reload.
    if (answered)
      await Promise.race([narrate($, sock, turn, log, 'end', ASK.end(turn.prompt, e.answer, turn.steps), e.turnId, true), $.clock.sleep(6000)]).catch(() => {})
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
    if (off) post($, sock, '/stop').catch(() => {})
    $.ui.status(off ? 'voice off' : undefined)
    return { text: off ? 'Voice off. Claude will reply in text only.' : 'Voice on. Claude talks to you as it works.' }
  })
}
