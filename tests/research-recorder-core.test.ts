import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Shared ESM module.
import { clockShift, normalizeRecorderConfig, sessionName, wavHeader } from '../research-recorder-core.mjs';

test('recorder defaults preserve analysis-ready capture quality', () => {
  const config = normalizeRecorderConfig();
  assert.equal(config.storageRoot, 'F:\\research-recordings');
  assert.deepEqual(config.camera, { width: 1280, height: 720, frameRate: 30 });
  assert.deepEqual(config.audio, { sampleRate: 48000, channels: 1, bitsPerSample: 16 });
  assert.equal(config.segmentMs, 600000);
});

test('session directory name is stable and filesystem safe', () => {
  assert.equal(sessionName(Date.parse('2026-09-08T00:00:00Z'), 'abc'), '2026-09-08T00-00-00-000Z_abc');
});

test('wav header describes mono 48 kHz PCM', () => {
  const header = wavHeader(96000);
  assert.equal(header.toString('ascii', 0, 4), 'RIFF');
  assert.equal(header.readUInt32LE(24), 48000);
  assert.equal(header.readUInt16LE(22), 1);
  assert.equal(header.readUInt32LE(40), 96000);
});

test('clock shift only reports wall-clock discontinuities', () => {
  assert.equal(clockShift({ utcMs: 1000, monotonicMs: 10 }, { utcMs: 2000, monotonicMs: 1010 }), null);
  assert.equal(clockShift({ utcMs: 1000, monotonicMs: 10 }, { utcMs: 4100, monotonicMs: 1010 }).differenceMs, 2100);
});
