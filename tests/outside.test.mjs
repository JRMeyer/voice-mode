import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outsidePlayers, outsideAudio } from '../server/outside.mjs';

test('afplay, say and ffplay count as outside audio', () => {
  const ps = [
    '  101 /usr/bin/afplay /tmp/clip.wav',
    '  102 say hello there',
    '  103 /opt/homebrew/bin/ffplay -nodisp -autoexit song.mp3',
    '  104 /bin/zsh -c afplay x.wav',
  ].join('\n');
  assert.deepEqual(outsidePlayers(ps, 1), [101, 102, 103]);
});

test("a voice-mode daemon's own sox player is not outside audio, sox playing a file is", () => {
  const ps = [
    '  201 /opt/homebrew/bin/play -q -t raw -r 24000 -e signed -b 16 -c 1 -',
    '  202 /opt/homebrew/bin/play /tmp/beep.wav',
  ].join('\n');
  assert.deepEqual(outsidePlayers(ps, 1), [202]);
});

test('other programs, blank lines and this process are ignored', () => {
  const ps = ['  301 /usr/libexec/replayd', '', '  302 node daemon.mjs /d/voice.sock', '  303 afplay a.wav'].join('\n');
  assert.deepEqual(outsidePlayers(ps, 303), []);
});

test('outsideAudio asks ps and answers a boolean', async () => {
  assert.equal(typeof (await outsideAudio({ maxAge: 0 })), 'boolean');
});
