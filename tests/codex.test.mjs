import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

async function fixture(run) {
  const home = mkdtempSync(join(tmpdir(), 'vm-'));
  const calls = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => { calls.push([req.url, body]); res.end(JSON.stringify({ok:true,sentences:1})); });
  });
  await new Promise(r => server.listen(join(home, 'codex.sock'), r));
  const narrator = join(home, 'narrator');
  writeFileSync(narrator, `#!/usr/bin/env node
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
require('fs').writeFileSync(${JSON.stringify(join(home,'request.json'))},JSON.stringify({args:process.argv.slice(2),input}));
if(process.env.TEST_FAIL) process.exit(1);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'The change is complete. All checks passed.'}}));
});`, { mode:0o755 });
  const env = {...process.env, VOICE_MODE_HOME:home, VOICE_MODE_NARRATOR:narrator};
  const hook = (e, extra={}) => new Promise((done,reject) => {
    const child=spawn(process.execPath,[resolve('codex/hook.mjs')],{env:{...env,...extra},stdio:['pipe','pipe','pipe']});
    child.on('error',reject);child.on('exit',code=>code ? reject(new Error(`exit ${code}`)):done());
    child.stdin.end(JSON.stringify({session_id:'test',turn_id:'turn',...e}));
  });
  try { await run({home,calls,hook}); } finally { await new Promise(r=>server.close(r)); rmSync(home,{recursive:true,force:true}); }
}

test('voice defaults on; final summary is queued before Stop exits', async()=>fixture(async({home,calls,hook})=>{
  await hook({hook_event_name:'UserPromptSubmit',prompt:'Fix the issue'});
  await hook({hook_event_name:'Stop',last_assistant_message:'The change is complete. All checks passed.'});
  assert(calls.some(([path,text])=>path.startsWith('/say?bare=1') && text.includes('The change is complete')));
  assert(readFileSync(join(home,'codex-narrator.log'),'utf8').includes('delivery=queued'));
  const request=JSON.parse(readFileSync(join(home,'request.json'),'utf8'));
  assert(request.args.includes('gpt-6-luna'));
  assert(request.args.includes('--ignore-user-config'));
  assert(request.args.includes('hooks'));
  assert(!request.args.includes('haiku'));
}));

test('narrator failure still queues a fallback final answer',async()=>fixture(async({home,calls,hook})=>{
  await hook({hook_event_name:'UserPromptSubmit',prompt:'Fix it'});
  await hook({hook_event_name:'Stop',last_assistant_message:'Fixed the sound. Checks passed.'},{TEST_FAIL:'1'});
  assert(calls.some(([path,text])=>path.startsWith('/say?bare=1')&&text==='Fixed the sound. Checks passed.'));
  assert(readFileSync(join(home,'codex-narrator.log'),'utf8').includes('FAILED'));
}));

test('duplicate Stop does not repeat the summary',async()=>fixture(async({calls,hook})=>{
  await hook({hook_event_name:'UserPromptSubmit',prompt:'Fix it'});
  const stop={hook_event_name:'Stop',last_assistant_message:'Done.'};
  await hook(stop);await hook(stop);
  assert.equal(calls.filter(([path,text])=>path.startsWith('/say?bare=1')&&text.includes('The change is complete')).length,1);
}));

test('muted voice makes no audio requests',async()=>fixture(async({home,calls,hook})=>{
  writeFileSync(join(home,'codex-off'),'');
  await hook({hook_event_name:'UserPromptSubmit',prompt:'Hello'});
  assert.equal(calls.length,0);
}));

test('narrator sees what it already said in earlier turns',async()=>fixture(async({home,hook})=>{
  await hook({hook_event_name:'UserPromptSubmit',prompt:'Run the eval'});
  await hook({hook_event_name:'Stop',last_assistant_message:'Eval started.'});
  const first=JSON.parse(readFileSync(join(home,'request.json'),'utf8'));
  assert(!first.input.includes('already said'));
  await hook({hook_event_name:'UserPromptSubmit',prompt:'How is it going?',turn_id:'turn2'});
  await hook({hook_event_name:'Stop',last_assistant_message:'Still running.',turn_id:'turn2'});
  const second=JSON.parse(readFileSync(join(home,'request.json'),'utf8'));
  assert(second.input.includes('already said'));
  assert(second.input.includes('- The change is complete. All checks passed.'));
}));

test('speech and stop are tagged with the session and project',async()=>fixture(async({calls,hook})=>{
  await hook({hook_event_name:'UserPromptSubmit',prompt:'Fix it',cwd:'/work/my-app'});
  const stop=calls.find(([path])=>path.startsWith('/stop'));
  assert.equal(stop[0],'/stop?session=test&label=my-app');
  const ack=calls.find(([path])=>path.startsWith('/say'));
  assert(ack[0].includes('session=test')&&ack[0].includes('label=my-app'));
  await hook({hook_event_name:'Stop',last_assistant_message:'Done.',cwd:'/work/my-app'});
  assert(calls.some(([path])=>path.startsWith('/say?bare=1&session=test&label=my-app')));
}));

test('"stop talking" turns the voice off; "you can talk again" turns it back on',async()=>fixture(async({home,calls,hook})=>{
  await hook({hook_event_name:'UserPromptSubmit',prompt:'Stop talking, just work.'});
  assert(existsSync(join(home,'codex-off')));
  assert(calls.some(([path])=>path.startsWith('/stop')));
  assert(!calls.some(([path,text])=>path.startsWith('/say')&&text!=='[click]'));
  calls.length=0;
  await hook({hook_event_name:'UserPromptSubmit',prompt:'Next task'});
  assert.equal(calls.length,0);
  await hook({hook_event_name:'UserPromptSubmit',prompt:'You can talk again. Next task',turn_id:'t3'});
  assert(!existsSync(join(home,'codex-off')));
  assert(calls.some(([path])=>path.startsWith('/say')));
}));
