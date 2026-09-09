import { createHash, randomUUID } from "node:crypto";
export const RECORDER_SCHEMA_VERSION = 2;
export const DEFAULT_RECORDER_CONFIG = Object.freeze({
  participantId: "participant_001",
  storageRoot: null,
  microphoneDeviceId: null,
  cameraDeviceId: null,
  segmentMs: 600_000,
  camera: { width: 1280, height: 720, frameRate: 30 },
  audio: { sampleRate: 48_000, channels: 1, bitsPerSample: 16 },
  setupComplete: false,
});
export function normalizeRecorderConfig(value = {}, documentsPath = null) {
  const participantId = String(
    value.participantId ?? DEFAULT_RECORDER_CONFIG.participantId,
  ).trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(participantId))
    throw new Error("参加者IDは英数字、_、- の1〜64文字で指定してください");
  const storageRoot = String(
    value.storageRoot ??
      (documentsPath ? `${documentsPath}/research-recordings` : ""),
  );
  if (!storageRoot.startsWith("/"))
    throw new Error("保存先にはmacOSの絶対パスを指定してください");
  return {
    ...DEFAULT_RECORDER_CONFIG,
    ...value,
    participantId,
    storageRoot,
    microphoneDeviceId:
      typeof value.microphoneDeviceId === "string" && value.microphoneDeviceId
        ? value.microphoneDeviceId
        : null,
    cameraDeviceId:
      typeof value.cameraDeviceId === "string" && value.cameraDeviceId
        ? value.cameraDeviceId
        : null,
    segmentMs: Math.max(60_000, Number(value.segmentMs) || 600_000),
    camera: { ...DEFAULT_RECORDER_CONFIG.camera, ...(value.camera ?? {}) },
    audio: { ...DEFAULT_RECORDER_CONFIG.audio, ...(value.audio ?? {}) },
  };
}
export function sessionName(ms, id = randomUUID()) {
  return `${new Date(ms).toISOString().replace(/[:.]/g, "-")}_${id}`;
}
export function clockAnchor() {
  return { utcMs: Date.now(), monotonicMs: performance.now() };
}
export function clockShift(a, b, toleranceMs = 1000) {
  if (!a) return null;
  const expected = a.utcMs + b.monotonicMs - a.monotonicMs,
    differenceMs = b.utcMs - expected;
  return Math.abs(differenceMs) > toleranceMs
    ? { expectedUtcMs: expected, actualUtcMs: b.utcMs, differenceMs }
    : null;
}
export function wavHeader(
  bytes,
  { sampleRate = 48_000, channels = 1, bitsPerSample = 16 } = {},
) {
  const h = Buffer.alloc(44),
    align = (channels * bitsPerSample) / 8;
  h.write("RIFF");
  h.writeUInt32LE(bytes + 36, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * align, 28);
  h.writeUInt16LE(align, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write("data", 36);
  h.writeUInt32LE(bytes, 40);
  return h;
}
export function safeInput(value) {
  if (
    !["keydown", "click", "scroll", "movement", "heartbeat", "gap"].includes(
      value?.type,
    )
  )
    throw new Error("Invalid input event");
  const row = { type: value.type };
  for (const k of [
    "timestamp_ms",
    "monotonic_ms",
    "interval_ms",
    "delta_x",
    "delta_y",
    "scroll_x",
    "scroll_y",
  ])
    if (value[k] === null || Number.isFinite(value[k])) row[k] = value[k];
  if (value.type === "gap" && typeof value.reason === "string")
    row.reason = value.reason.slice(0, 200);
  if (!Number.isFinite(row.timestamp_ms))
    throw new Error("Input timestamp required");
  return row;
}
export function splitPcm16(buffer, remainingSamples) {
  const bytes = Math.max(0, remainingSamples) * 2,
    copy = Buffer.from(buffer);
  const part = copy.subarray(0, bytes);
  return { part, rest: copy.subarray(part.length), samples: part.length / 2 };
}
export function reconnectDelay(attempt) {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}
export function checksum(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
