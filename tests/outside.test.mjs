import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outsidePlayers, outsideAudio, isOutsidePlayer, OUR_PLAYER } from '../server/outside.mjs';

// Lines as `ps -A -ww -o pid= -o stat= -o ucomm= -o args=` prints them.
const ps = lines => lines.join('\n');

test('afplay, say, ffplay and mpv count as outside audio', () => {
  assert.deepEqual(outsidePlayers(ps([
    '  101 S    afplay           /usr/bin/afplay /tmp/clip one.wav',
    '  102 S    say              say hello there',
    '  103 S    ffplay           /opt/homebrew/bin/ffplay -nodisp -autoexit song.mp3',
    '  104 S    mpv              mpv song.flac',
  ]), 1), [101, 102, 103, 104]);
});

test('a zombie player, say writing a file and an idle mpv play nothing', () => {
  assert.deepEqual(outsidePlayers(ps([
    '  401 Z    afplay           afplay a.wav',
    '  402 S    say              say -o out.aiff hello',
    '  403 S    mpv              mpv --idle',
    '  404 S+   afplay           afplay b.wav',
  ]), 1), [404]);
});

test('a player in a folder with spaces is found by its process name', () => {
  assert.equal(isOutsidePlayer('afplay', '/Users/me/My Tools/afplay clip.wav'), true);
});

test('a player run through a link is found by the name it was run as', () => {
  // macOS names the process after the file the link points to.
  assert.equal(isOutsidePlayer('sleep', '/tmp/x/afplay 3'), true);
});

test('sox plays when run as play or with -d, not when it converts a file', () => {
  assert.equal(isOutsidePlayer('sox', '/opt/homebrew/bin/play /tmp/beep.wav'), true);   // macOS
  assert.equal(isOutsidePlayer('play', 'play /tmp/beep.wav'), true);                      // Linux
  assert.equal(isOutsidePlayer('sox', 'sox clip.wav -d'), true);
  assert.equal(isOutsidePlayer('sox', 'sox in.wav out.mp3'), false);
});

test("voice-mode's own players, new and from before 0.5.15, are not outside audio", () => {
  assert.equal(isOutsidePlayer('sox', `${OUR_PLAYER} -q -t raw -r 24000 -e signed -b 16 -c 1 -`), false);
  assert.equal(isOutsidePlayer('sox', '/opt/homebrew/bin/play -q -t raw -r 24000 -e signed -b 16 -c 1 -'), false);
  // Someone else's raw sox stream is still a player.
  assert.equal(isOutsidePlayer('sox', 'play -t raw -r 8000 -e signed -b 16 -c 1 -'), true);
});

test('other programs, the shell that ran a player, blank lines and this process are ignored', () => {
  assert.deepEqual(outsidePlayers(ps([
    '  301 S    replayd          /usr/libexec/replayd',
    '',
    '  302 S    zsh              /bin/zsh -c afplay x.wav',
    '  303 S    node             node daemon.mjs /d/voice.sock',
    '  304 S    afplay           afplay a.wav',
  ]), 304), []);
});

test('when ps cannot run, outside audio is no and the error is reported', async () => {
  const path = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    let error;
    assert.equal(await outsideAudio({ maxAge: 0, onError: e => (error = e) }), false);
    assert.ok(error);
  } finally { process.env.PATH = path; }
});

test('callers asking at the same time share one ps', async () => {
  const [a, b] = [outsideAudio({ maxAge: 0 }), outsideAudio({ maxAge: 0 })];
  assert.equal(a, b);
  assert.equal(typeof (await a), 'boolean');
});
