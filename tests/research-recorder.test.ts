import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Shared JavaScript module.
import { clockShift, normalizeRecorderConfig, safeRelativeMediaPath, sessionName, wavHeader } from '../research-recorder-core.mjs';

test('recorder config is analysis-free and uses requested capture defaults', () => {
  const value = normalizeRecorderConfig({ participantId: 'P_01' });
  assert.equal(value.storageRoot, 'F:\\research-recordings');
  assert.deepEqual(value.camera, { width: 1280, height: 720, frameRate: 30 });
  assert.deepEqual(value.audio, { sampleRate: 48000, channels: 1, bitsPerSample: 16 });
  assert.equal(value.segmentMs, 600000);
});

test('session and media names are deterministic and traversal-safe', () => {
  assert.equal(sessionName(0, 'abc'), '1970-01-01T00-00-00-000Z_abc');
  assert.equal(safeRelativeMediaPath('camera', 2, 'webm'), 'camera/camera-0002.webm');
  assert.throws(() => safeRelativeMediaPath('../x', 0, 'webm'));
});

test('wav header describes 48kHz mono PCM and clock shifts are detected', () => {
  const header = wavHeader(96000);
  assert.equal(header.toString('ascii', 0, 4), 'RIFF');
  assert.equal(header.readUInt32LE(24), 48000);
  assert.equal(header.readUInt16LE(22), 1);
  assert.equal(clockShift({ utcMs: 1000, monotonicMs: 10 }, { utcMs: 5000, monotonicMs: 1010 })?.differenceMs, 3000);
  assert.equal(clockShift({ utcMs: 1000, monotonicMs: 10 }, { utcMs: 2000, monotonicMs: 1010 }), null);
});
