#!/usr/bin/env node
// Approve the voice-mode plugin's Codex hooks in one step, instead of one by one in Codex's /hooks screen.
// Codex does not run a plugin's hooks until you approve them, and asks again after every plugin update.
//
//   node codex/trust-hooks.mjs          lists the hooks and asks before changing anything
//   node codex/trust-hooks.mjs --yes    approves without asking
//
// It asks Codex (`codex app-server`, method hooks/list) for the voice-mode hooks and their current hashes,
// then writes them as trusted to config.toml in your Codex home. It touches only voice-mode entries, and
// keeps a backup of the config next to it (config.toml.bak-voice-mode).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PREFIX = "voice-mode@";
const CONFIG = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");

function listHooks() {
  return new Promise((done, fail) => {
    const p = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => { p.kill(); fail(new Error("codex app-server did not answer in 30 seconds")); }, 30000);
    p.on("error", err => { clearTimeout(timer); fail(new Error(`cannot run codex: ${err.message}`)); });
    createInterface({ input: p.stdout }).on("line", line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.id !== 2) return;
      clearTimeout(timer); p.kill();
      if (m.error) return fail(new Error(m.error.message));
      done(m.result.data.flatMap(e => e.hooks).filter(h => h.key.startsWith(PREFIX)));
    });
    for (const m of [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "voice-mode-trust", version: "1" } } },
      { jsonrpc: "2.0", method: "initialized" },
      { jsonrpc: "2.0", id: 2, method: "hooks/list", params: { cwds: [process.cwd()] } },
    ]) p.stdin.write(JSON.stringify(m) + "\n");
  });
}

// Drop every existing [hooks.state."voice-mode@..."] table, header through the line before the next table.
function withoutVoiceEntries(toml) {
  const out = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) skipping = line.trim().startsWith(`[hooks.state."${PREFIX}`);
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

const ask = q => new Promise(done => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, a => { rl.close(); done(a.trim().toLowerCase()); });
});

const hooks = await listHooks().catch(err => { console.error(err.message); process.exit(1); });
if (!hooks.length) {
  console.error("No voice-mode hooks found. Install the plugin first: codex plugin add voice-mode@voice-mode");
  process.exit(1);
}
console.log(`voice-mode hooks in Codex (${CONFIG}):`);
for (const h of hooks) console.log(`  ${h.eventName.padEnd(18)} ${h.trustStatus}`);
if (hooks.every(h => h.trustStatus === "trusted")) { console.log("All approved already."); process.exit(0); }

if (!process.argv.includes("--yes") && (await ask("Approve all of them? [y/N] ")) !== "y") {
  console.log("Nothing changed.");
  process.exit(0);
}

const before = existsSync(CONFIG) ? readFileSync(CONFIG, "utf8") : "";
if (before) copyFileSync(CONFIG, `${CONFIG}.bak-voice-mode`);
const entries = hooks.map(h => {
  const [hash, contentHash] = h.currentHash.split("/");
  return `[hooks.state."${h.key}"]\ntrusted_hash = "${hash}"\n${contentHash ? `trusted_content_hash = "${contentHash}"\n` : ""}`;
});
writeFileSync(CONFIG, withoutVoiceEntries(before) + "\n" + entries.join("\n"));

const after = await listHooks().catch(() => []);
const ok = after.length && after.every(h => h.trustStatus === "trusted");
console.log(ok ? `Approved ${after.length} hooks. Start a new Codex session to use them.`
  : `Codex does not show them as approved: ${after.map(h => `${h.eventName}=${h.trustStatus}`).join(", ")}. Your old config is in ${CONFIG}.bak-voice-mode.`);
process.exit(ok ? 0 : 1);
