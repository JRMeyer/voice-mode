import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wantsQuiet, wantsVoice } from '../shared/narration.mjs';

test('plain requests for silence are recognized', () => {
  for (const t of ['stop talking', 'Stop talking.', 'go quiet for now, until all PRs are merged. keep chugging along',
    'please be quiet', 'shut up', 'mute', 'shh', 'voice off', 'no more narration please', 'stop talking to me'])
    assert(wantsQuiet(t), t);
});

test('ordinary messages are not', () => {
  for (const t of ['fix the bug where the client should stop talking to the server', 'make the logs quieter',
    'add a mute button to the player', 'why is the build silent about errors?', 'keep going'])
    assert(!wantsQuiet(t), t);
});

test('asking for the voice back', () => {
  for (const t of ['you can talk again', 'ok to speak now', 'voice on', 'unmute', 'resume talking']) assert(wantsVoice(t), t);
  assert(!wantsVoice('you can talk again later, for now stop talking'));
  assert(!wantsVoice('talk me through the code'));
});
