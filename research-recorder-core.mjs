import { createHash, randomUUID } from 'node:crypto';

export const RECORDER_SCHEMA_VERSION = 1;
export const DEFAULT_RECORDER_CONFIG = Object.freeze({
  participantId: 'participant_001',
  storageRoot: 'F:\\research-recordings',
  microphoneDeviceId: null,
  cameraDeviceId: null,
  segmentMs: 10 * 60_000,
  camera: { width: 1280, height: 720, frameRate: 30 },
  audio: { sampleRate: 48_000, channels: 1, bitsPerSample: 16 },
});

export function normalizeRecorderConfig(value = {}) {
  const participantId = String(value.participantId ?? DEFAULT_RECORDER_CONFIG.participantId).trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(participantId)) throw new Error('参加者IDは英数字、_、- の1〜64文字で指定してください');
  const storageRoot = String(value.storageRoot ?? DEFAULT_RECORDER_CONFIG.storageRoot);
  if (!/^[A-Za-z]:\\[^<>:"|?*]*$/.test(storageRoot)) throw new Error('保存先にはWindowsの絶対パスを指定してください');
  return {
    ...DEFAULT_RECORDER_CONFIG,
    ...value,
    participantId,
    storageRoot,
    microphoneDeviceId: typeof value.microphoneDeviceId === 'string' && value.microphoneDeviceId ? value.microphoneDeviceId : null,
    cameraDeviceId: typeof value.cameraDeviceId === 'string' && value.cameraDeviceId ? value.cameraDeviceId : null,
    segmentMs: Math.max(60_000, Number(value.segmentMs) || DEFAULT_RECORDER_CONFIG.segmentMs),
    camera: { ...DEFAULT_RECORDER_CONFIG.camera, ...(value.camera ?? {}) },
    audio: { ...DEFAULT_RECORDER_CONFIG.audio, ...(value.audio ?? {}) },
  };
}

export function sessionName(startedAtMs, id = randomUUID()) {
  return `${new Date(startedAtMs).toISOString().replace(/[:.]/g, '-')}_${id}`;
}

export function clockAnchor() {
  return { utcMs: Date.now(), monotonicMs: performance.now() };
}

export function clockShift(previous, current, toleranceMs = 1000) {
  if (!previous) return null;
  const expected = previous.utcMs + (current.monotonicMs - previous.monotonicMs);
  const differenceMs = current.utcMs - expected;
  return Math.abs(differenceMs) > toleranceMs ? { expectedUtcMs: expected, actualUtcMs: current.utcMs, differenceMs } : null;
}

export function wavHeader(dataBytes, { sampleRate = 48_000, channels = 1, bitsPerSample = 16 } = {}) {
  const header = Buffer.alloc(44), blockAlign = channels * bitsPerSample / 8, bytesPerSecond = sampleRate * blockAlign;
  header.write('RIFF', 0); header.writeUInt32LE(dataBytes + 36, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(bytesPerSecond, 28); header.writeUInt16LE(blockAlign, 32); header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36); header.writeUInt32LE(dataBytes, 40); return header;
}

export function safeRelativeMediaPath(kind, index, extension) {
  if (!['camera', 'audio', 'obs'].includes(kind) || !Number.isInteger(index) || index < 0 || !/^[a-z0-9]+$/i.test(extension)) throw new Error('Invalid media path');
  return `${kind}/${kind}-${String(index).padStart(4, '0')}.${extension}`;
}

export function checksum(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
