import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// @ts-expect-error Shared JavaScript module.
import { clockShift, normalizeRecorderConfig, reconnectDelay, safeInput, sessionName, splitPcm16, wavHeader } from '../research-recorder-core.mjs';

test('recorder config is analysis-free and uses requested capture defaults', () => {
  const value = normalizeRecorderConfig({ participantId: 'P_01' }, '/Users/test/Documents');
  assert.equal(value.storageRoot, '/Users/test/Documents/research-recordings');
  assert.deepEqual(value.camera, { width: 1280, height: 720, frameRate: 30 });
  assert.deepEqual(value.audio, { sampleRate: 48000, channels: 1, bitsPerSample: 16 });
  assert.equal(value.segmentMs, 600000);
});

test('session names are deterministic', () => {
  assert.equal(sessionName(0, 'abc'), '1970-01-01T00-00-00-000Z_abc');
});

test('wav header describes 48kHz mono PCM and clock shifts are detected', () => {
  const header = wavHeader(96000);
  assert.equal(header.toString('ascii', 0, 4), 'RIFF');
  assert.equal(header.readUInt32LE(24), 48000);
  assert.equal(header.readUInt16LE(22), 1);
  assert.equal(clockShift({ utcMs: 1000, monotonicMs: 10 }, { utcMs: 5000, monotonicMs: 1010 })?.differenceMs, 3000);
  assert.equal(clockShift({ utcMs: 1000, monotonicMs: 10 }, { utcMs: 2000, monotonicMs: 1010 }), null);
});

test('input sanitization never retains key material', () => {
  assert.deepEqual(safeInput({type:'keydown',timestamp_ms:1,monotonic_ms:2,interval_ms:3,key:'secret',keyCode:42,clipboard:'secret'}),{type:'keydown',timestamp_ms:1,monotonic_ms:2,interval_ms:3});
  assert.throws(()=>safeInput({type:'keyup',timestamp_ms:1,key:'x'}));
});

test('PCM splitting preserves samples at a boundary', () => {
  const first=splitPcm16(Buffer.alloc(20),6);
  assert.equal(first.samples,6);assert.equal(first.part.length,12);assert.equal(first.rest.length,8);
});

test('reconnect backoff is capped',()=>{assert.equal(reconnectDelay(0),1000);assert.equal(reconnectDelay(9),30000)});

test('macOS input helper never accesses key or clipboard data',async()=>{
  const source=await readFile(new URL('../swift/InputCollector.swift',import.meta.url),'utf8');
  for(const forbidden of ['keyboardEventKeycode','keyboardGetUnicodeString','CGEventKeyboardGetUnicodeString','NSPasteboard'])assert.equal(source.includes(forbidden),false);
  assert.equal(source.includes('AXIsProcessTrusted()'),false);
  assert.ok(source.indexOf('CGEvent.tapCreate') < source.indexOf('emit("permission",["granted":true])'));
});

test('recorder does not start analysis models',async()=>{
  const source=await readFile(new URL('../recorder-electron.mjs',import.meta.url),'utf8');
  for(const forbidden of ['whisper','silero','face_recognition','vad_model'])assert.equal(source.toLowerCase().includes(forbidden),false);
});
