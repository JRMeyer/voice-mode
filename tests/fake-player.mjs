#!/usr/bin/env node
// A stand-in for sox play in the daemon tests: takes raw 16-bit mono audio on stdin, appends it to
// $VOICE_MODE_TEST_OUT/<pid>.raw, and like a real player exits only once all of it would have been heard.
import { appendFileSync } from 'node:fs';
const rate = Number(process.argv[process.argv.indexOf('-r') + 1]) || 24000;
const out = `${process.env.VOICE_MODE_TEST_OUT}/${process.pid}.raw`;
let bytes = 0, t0 = 0;
appendFileSync(out, '');
process.stdin.on('data', d => { t0 ||= Date.now(); bytes += d.length; appendFileSync(out, d); });
process.stdin.on('end', () => setTimeout(() => process.exit(0), Math.max(0, t0 + (bytes / 2 / rate) * 1000 - Date.now())));
