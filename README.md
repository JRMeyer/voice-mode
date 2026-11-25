# voice mode

A plugin for Claude Code, Codex and OpenCode that lets the agent talk to you out loud. A small, fast model writes the spoken lines from what the main session does (Claude Haiku in Claude Code, a small OpenAI model in Codex, your `small_model` in OpenCode), so the main model never spends a step on speech. Things you should look at (tables, code, file paths) stay on screen.

- **Voice:** runs on your own computer with [tiny-voca](https://github.com/n4ze3m/tiny-voca). It ships a custom tiny-voca voice, `models/robo-josh.gguf`, and tiny-voca's JavaScript engine in `vendor/tiny-voca`, so there is nothing else to download.
- **Persona:** a friendly 1980s movie robot. It speaks in short, clipped sentences.
- **Robot sounds:** tags in the spoken text play in place, used sparingly (one per line, plus one for a real result): `[beep] [boop] [click] [servo] [think] [success] [error] [boot]`. The robot tones are synthesized in `server/sfx.mjs`. Typing, mute confirmation, and the long-step thunk use the bundled Button Sounds recordings in `assets/button-sounds/`.
- **What you hear:** a short acknowledgment as soon as you press Enter, a check-in on long turns, and at the end a short summary of what Claude did and what it found, with the next step. Each narrator call is logged to `narrator.log` in the plugin's data folder with latency, tokens and the spoken text.
- **Audio cues:**
  - While Claude works, a short soft sound plays every 12 to 20 seconds, so silence means it is done or waiting on you. It tells you what kind of work: a soft Rolodex riffle for reading, clicky mechanical keyboard typing for writing, a motor whir for running a command (a shell command that only reads files, like `cat` or `grep`, counts as reading, and one that writes a file counts as writing), a paper shredder for deleting files (`rm`, `git rm`), soft radio beeps over static for web search or browsing, beeps and boops for thinking.
  - When Claude needs you (a permission prompt, a question, a plan to approve), a two-note chime plays and the voice says what is on screen, reading out a question's choices. The chime repeats every 30 seconds until you answer.
  - At the end of a turn, a rising chirp means it went well and a low buzz means something failed, before the spoken summary.
  - A heavier thunk marks a step that took 30 seconds or more, with a short spoken note about it.
- **Pronunciation:** `server/pronounce.txt` lists words the voice gets wrong, as `word = how to say it`. Contractions are expanded before speaking ("cannot", not "can't").
- **Welcome and waitlist:** the very first time the voice speaks, it says a short welcome once, and one line on screen offers a spot on the waitlist for what comes next. Type `/waitlist you@example.com` to get one email when it is ready. Your email goes to a Kit mailing list and is used only for this.
- **On/off:** type `/voice-mode off` or `/voice-mode on`, or just say so in a message: "stop talking", "go quiet" or "shut up" turns the voice off at once (a click confirms it), and "you can talk again" or "voice on" turns it back on. New messages, including ones sent while Claude works, stop any speech still playing.

## Requirements

- macOS or Linux with Node 22 or newer.
- sox, for audio playback: `brew install sox`.

## Install

### Claude Code

```
/plugin marketplace add JRMeyer/voice-mode
/plugin install voice-mode@voice-mode
```

### Codex

```
codex plugin marketplace add JRMeyer/voice-mode
codex plugin add voice-mode@voice-mode
```

Codex does not run a plugin's hooks until you approve them, and it asks again after every plugin update. Approve all six voice-mode hooks with one command:

```
node ~/.codex/plugins/cache/voice-mode/voice-mode/*/codex/trust-hooks.mjs
```

It lists the hooks, asks before changing anything, and backs up your Codex config to `config.toml.bak-voice-mode`. Add `--yes` to skip the question. Or approve them by hand: start Codex, type `/hooks`, and approve each voice-mode hook.

### OpenCode

Clone the repository, then add the plugin's path to `plugin` in `~/.config/opencode/opencode.json`:

```
git clone https://github.com/JRMeyer/voice-mode ~/code/voice-mode
```

```json
{ "plugin": ["~/code/voice-mode/opencode/plugin.mjs"] }
```

Use the full path to your clone (OpenCode does not expand `~`). Restart OpenCode after adding it.

## Codex

Install from a configured marketplace with `codex plugin add voice-mode@voice-mode`.
Approve the plugin's hooks after installing and after each update (see Install above). Voice defaults to on; say “voice off” to mute it
or “voice on” to unmute it. The mute setting persists across sessions.

Codex uses its own authenticated CLI for narration, with `gpt-6-luna` and low
reasoning effort. It does not need Claude or an Anthropic account. Set
`VOICE_MODE_NARRATOR_MODEL` to choose another available OpenAI model, or
`VOICE_MODE_NARRATOR` to choose the Codex executable. The narrator is ephemeral,
runs outside the project, ignores user config, and disables hooks, shell tools,
apps, and multi-agent support to avoid recursive narration.

The Stop hook waits until the final spoken summary is queued, with a 12-second
model timeout and a plain-text fallback if generation fails. A requested speech
line earlier in the turn does not suppress the summary. Starting a new prompt
interrupts existing audio and discards stale narration. Progress summaries are
discarded if the turn has already ended.

Logs in `~/.voice-mode/codex-narrator.log` identify the model, generation failures,
and whether audio was queued or delivery failed. Queuing confirms delivery to
the local audio daemon, not that the speaker was audible. The daemon writes
playback diagnostics to `~/.voice-mode/codex.sock.log`.

Background sounds and playback use the same shared daemon as Claude Code.

Run the Codex integration checks with `node --test tests/codex.test.mjs` (all checks: `node --test tests/*.test.mjs`).
They use a fake narrator and audio socket; no model calls or audio playback.

## How it works

- `hooks/register.ts`:
  - At session start, it starts the voice program on a private socket.
  - It registers the `/voice-mode` command.
  - With each message you send, it stops any speech still playing.
  - It calls Haiku (`$.model.complete`) at turn start, on long turns, and at turn end, and sends the line to the voice program.
- `server/daemon.mjs`:
  - Keeps the model loaded and splits text into sentences and sound tags.
  - Makes the speech and plays everything in order through one `sox play` stream.
  - Answers `POST /say`, `/stop`, `/mute`, `/hum/on`, `/hum/off`, `/activity`, `/wait/start`, `/wait/stop`, `/quit` and `/health` over a Unix socket. A new daemon for the same session asks the old one to quit, and the old one finishes any speech in flight first.
- `server/floor.mjs`: one voice at a time across every session on the machine (see below).
- `server/sfx.mjs`: makes the robot sounds.
- `server/client.mjs`: posts to the daemon, mutes it (an older daemon still running after an update too) and starts it, for Codex and OpenCode.
- `shared/narration.mjs`: the narrator prompts and helpers that all three hosts share. It has no imports, so Claude Code's sandbox can load it.

### Several sessions at once

Every daemon on the machine, Claude Code and Codex alike, shares one lock file, `~/.voice-mode/floor.lock`. A daemon takes it before it plays and gives it back when it is done, so two sessions never talk over each other.

- Sessions take turns between messages, never in the middle of one. The one that has waited longest goes next.
- A session that needs you (a permission prompt or a question) goes ahead of routine narration.
- When the voice switches to another project, the line starts with the project name, such as "In my app." With one session running you never hear it.
- Stale audio is dropped instead of queued: working sounds never wait for another session, and a check-in that waits over 20 seconds, or whose turn has ended, does not play.
- A new message stops only that session's speech. Turning the voice off stops all sound from that session's daemon at once. In Codex and OpenCode one daemon serves every session, so that is all of them.

Run the checks with `node --test tests/*.test.mjs`. The Claude Code hooks have their own, run with `claude plugin test .`.

### Codex

Codex runs each hook as its own short process and gives plugins no model call, so the Codex side works differently:

- `.codex-plugin/plugin.json` declares six command hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`) that run `codex/hook.mjs`, and an MCP server, `codex/mcp.mjs`.
- One daemon serves every Codex session, on `~/.voice-mode/codex.sock`. Turn state is kept in small files in `~/.voice-mode`.
- The narrator runs a small OpenAI model through `codex exec` (see the Codex section above). The "got it" line at the start is picked at random from a short list of fixed phrases in `shared/narration.mjs`, so it plays at once. If the narrator fails, the end summary falls back to the answer's first two sentences.
- Codex has no plugin slash commands. To turn voice on or off, ask Codex ("voice off"): it calls the `voice_mode` tool. The `voice_mode` tool runs without an approval prompt.

### Environment overrides

| Variable | Sets | Default |
| --- | --- | --- |
| `VOICE_MODE_MODEL` | the voice model file | the bundled model |
| `VOICE_MODE_VOICE` | the voice ID | `M2` |
| `VOICE_MODE_PLAYER` | the sox `play` program | sox `play` |
| `VOICE_MODE_JS` | tiny-voca's `js` folder | the bundled copy in `vendor/tiny-voca` |
| `VOICE_MODE_HOME` | the shared floor lock; for Codex also the state and socket folder | `~/.voice-mode` |
| `VOICE_MODE_LABEL` | the project name said when the voice switches projects | the project folder's name |
| `VOICE_MODE_NARRATOR` | Codex only: the Codex executable the narrator runs | `codex` |
| `VOICE_MODE_NARRATOR_MODEL` | Codex only: the narrator model | `gpt-6-luna` |
| `VOICE_MODE_DEBUG` | Codex only: log every hook payload to `codex-hooks.log` | off |

## OpenCode

The plugin runs inside OpenCode and uses its own daemon at `~/.voice-mode/opencode.sock`. It maps OpenCode's events onto the same sounds and speech:

- A new message: stop old speech, a short acknowledgment, working sounds on.
- Each tool call sets the working sound. A step of 30 seconds or more gets a thunk and, if nothing was said lately, a spoken note.
- A permission prompt or a `question` tool: the chime and a spoken line, until you answer.
- The session goes idle: the result tone, then a spoken summary.

The narrator is OpenCode's own model, called in a throwaway session as the hidden `summary` agent, with no tools. It uses `small_model` from your OpenCode config, or the chat's model if none is set. Narrator calls run with thinking turned off (only those calls: your chat keeps its settings), so a thinking model answers in a second or two instead of 10 to 35. Subagent sessions stay silent.

| Variable | Default | What it does |
| --- | --- | --- |
| `VOICE_MODE_NARRATOR_MODEL` | `small_model` | Narrator model, as `provider/model`. |
| `VOICE_MODE_NARRATOR_AGENT` | `summary` | OpenCode agent for narrator calls. Empty uses the default agent. |
| `VOICE_MODE_NARRATOR_TIMEOUT_MS` | `20000` | How long to wait for the narrator before speaking the answer's first sentences. |
| `VOICE_MODE_NODE` | `node` | Node executable that runs the daemon (OpenCode plugins run in Bun). |

Turn the voice off with "stop talking" or "voice off" in a message; "voice on" turns it back on. The setting is kept in `~/.voice-mode/opencode-off`. Narrator calls are logged to `~/.voice-mode/opencode-narrator.log`.

## License

The code is licensed under the Apache License 2.0 (see `LICENSE`). The voice model in `models/` is licensed under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/): free for non-commercial use with credit; for commercial use, open an issue to ask. It is fine-tuned from [tiny-voca](https://huggingface.co/n4ze3m/tiny-voca) (Apache 2.0); see `models/NOTICE`. The tiny-voca engine in `vendor/tiny-voca` is Apache 2.0; see `vendor/tiny-voca/NOTICE`.
