import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf } from '../shared/narration.mjs';

const bash = command => activityOf('Bash', { command });

test('dedicated tools keep their kind', () => {
  assert.equal(activityOf('Read'), 'read');
  assert.equal(activityOf('Edit'), 'write');
  assert.equal(activityOf('WebSearch'), 'web');
  assert.equal(activityOf('Agent'), 'run');
  assert.equal(activityOf('Bash'), 'run');                       // no command given
});

test('shell commands that only look at files are reading', () => {
  for (const c of ['cat README.md', 'sed -n 75,110p shared/narration.mjs', 'grep -rn "a|b" server | head -20',
    'cd /w && git log --oneline -5', 'git -C /w status', 'git diff --stat', 'find . -name "*.mjs"',
    'ls -la && wc -l server/*.mjs', 'rg foo 2>/dev/null', 'grep -n x a.js 2>&1 | head', 'git branch',
    'cat a; echo "---"; cat b', 'LC_ALL=C sort file | uniq -c', '/usr/bin/head -5 x'])
    assert.equal(bash(c), 'read', c);
});

test('shell commands that write files are writing', () => {
  for (const c of ['sed -i "" "s/a/b/" file.js', 'echo hi > notes.txt', 'cat a b >> c', 'git diff | tee out.patch',
    "cat > x.txt <<'EOF'\nnpm install\nrm -rf /\nEOF", 'sed --in-place s/a/b/ f', 'cd /w && printf x > y'])
    assert.equal(bash(c), 'write', c);
});

test('everything else is running', () => {
  for (const c of ['npm test', 'node --test tests/*.test.mjs', 'cat x | node script.js', 'git commit -m "cat file"',
    'git checkout -b new', 'git branch -D old', 'find . -exec rm {} \\;', 'rm -rf build && npm test',
    'cat $(ls)', 'echo `whoami`', 'npm test > out.txt', 'cd /w', 'grep x a && make'])
    assert.equal(bash(c), 'run', c);
});

test('Codex and OpenCode shell inputs are read too', () => {
  assert.equal(activityOf('exec_command', { cmd: 'cat x' }), 'read');
  assert.equal(activityOf('shell', { command: ['bash', '-lc', 'sed -n 1,5p x'] }), 'read');
  assert.equal(activityOf('shell', { command: ['ls', '-la'] }), 'read');
  assert.equal(activityOf('bash', { command: 'echo x > y' }), 'write');
  assert.equal(activityOf('local_shell', { command: ['bash', '-lc', 'npm test'] }), 'run');
});

test('deleting files is deleting', () => {
  for (const c of ['rm notes.txt', 'rm -rf build', 'cd /w && rm -f a b', 'rmdir old', 'git rm -q x.js', 'git clean -fd',
    'find . -name "*.tmp" -delete', 'ls x && rm x', 'rm a.txt 2>/dev/null; echo done > log', '/bin/rm x'])
    assert.equal(bash(c), 'delete', c);
  assert.equal(activityOf('apply_patch', { input: '*** Begin Patch\n*** Delete File: a.js\n*** Delete File: b.js\n*** End Patch' }), 'delete');
  assert.equal(activityOf('apply_patch', { input: '*** Begin Patch\n*** Delete File: a.js\n*** Add File: b.js\n+x\n*** End Patch' }), 'write');
  assert.equal(activityOf('apply_patch', '*** Begin Patch\n*** Update File: a.js\n*** End Patch'), 'write');
});
