import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  session,
  shell,
  safeStorage,
  systemPreferences,
  powerMonitor,
} from "electron";
import {
  appendFile,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  statfs,
  unlink,
  writeFile,
  access,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { arch, platform, release } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { RawStudy } from "./raw-study.mjs";
import {
  clockAnchor,
  clockShift,
  normalizeRecorderConfig,
  RECORDER_SCHEMA_VERSION,
  sessionName,
  splitPcm16,
  wavHeader,
} from "./research-recorder-core.mjs";
if (process.platform !== "darwin")
  throw new Error("Research Recorder is macOS only");
const root = import.meta.dirname,
  smoke = process.argv.includes("--smoke-test"),
  stopAfter =
    Number(
      process.argv.find((x) => x.startsWith("--stop-after="))?.split("=")[1],
    ) || null;
app.setName("Research Recorder");
if (smoke)
  app.setPath(
    "userData",
    join(app.getPath("temp"), `research-recorder-smoke-${process.pid}`),
  );
const userData = app.getPath("userData"),
  configPath = join(userData, "config.json"),
  secretPath = join(userData, "obs-secret.bin"),
  statusPath = join(userData, "status.json");
const bundled = app.isPackaged ? process.resourcesPath : root;
const helperPath = join(bundled, "bin", "input-collector-macos");
const ffmpegPath = app.isPackaged
  ? join(bundled, "bin", "ffmpeg")
  : join(
      root,
      "node_modules",
      "ffmpeg-static",
      process.arch === "arm64" ? "ffmpeg" : "ffmpeg",
    );
let config = normalizeRecorderConfig({}, app.getPath("documents")),
  saved = false;
try {
  config = normalizeRecorderConfig(
    JSON.parse(await readFile(configPath, "utf8")),
    app.getPath("documents"),
  );
  saved = true;
} catch {}
let win,
  tray,
  quitting = false,
  manualStopped = !saved,
  raw = null,
  input = null,
  inputStopping = false,
  inputHeartbeat = 0,
  previousAnchor = null;
let cameraHandle = null,
  cameraPath = null,
  cameraStart = null,
  cameraIndex = 0,
  audioHandle = null,
  audioPath = null,
  audioStart = null,
  audioIndex = 0,
  audioSamples = 0;
let obsOwned = false,
  obsOwnershipUncertain = false,
  obsOriginalDir = null,
  obsOriginalFormat = null,
  obsFormatKey = null,
  obsCurrentPath = null,
  obsSegmentStart = null,
  virtualCamOwned = false,
  mediaReady = false,
  mediaReadyResolve = null,
  writeQueue = Promise.resolve(),
  persistQueue = Promise.resolve(),
  timers = [];
const state = {
  state: "waiting",
  message: "初回設定を保存してください",
  sessionId: null,
  sessionDir: null,
  startedAtMs: null,
  stoppedAtMs: null,
  config,
  platform: { os: platform(), release: release(), arch: arch() },
  permissions: {
    camera: "unknown",
    microphone: "unknown",
    accessibility: "unknown",
  },
  channels: {
    activitywatch: { state: "disconnected", detail: "未確認" },
    input: { state: "disconnected", detail: "未確認" },
    obs: { state: "disconnected", detail: "未確認" },
    camera: { state: "disconnected", detail: "未確認" },
    audio: { state: "disconnected", detail: "未確認" },
  },
  events: [],
  files: [],
  gaps: [],
  clockAnchors: [],
  devices: {},
};
const pub = () => structuredClone(state);
const setChannel = (name, value, detail) =>
  (state.channels[name] = { state: value, detail });
function event(type, details = {}) {
  const row = {
    at: Date.now(),
    monotonicMs: performance.now(),
    type,
    ...details,
  };
  state.events.push(row);
  if (state.events.length > 200) state.events.shift();
  if (state.sessionDir)
    writeQueue = writeQueue
      .then(() =>
        appendFile(
          join(state.sessionDir, "events.jsonl"),
          JSON.stringify(row) + "\n",
        ),
      )
      .catch((e) => emergency(e));
  return row;
}
async function emergency(e) {
  state.message = String(e);
  setChannel("audio", "save_failed", String(e));
  await mkdir(userData, { recursive: true }).catch(() => {});
  await appendFile(
    join(userData, "emergency-errors.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      error: String(e),
      sessionDir: state.sessionDir,
    }) + "\n",
  ).catch(() => {});
}
async function atomicJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}
function persist(completion = "recording") {
  if (!state.sessionDir) return Promise.resolve();
  persistQueue = persistQueue
    .then(() =>
      atomicJson(join(state.sessionDir, "session.json"), {
        schemaVersion: RECORDER_SCHEMA_VERSION,
        sessionId: state.sessionId,
        participantId: config.participantId,
        startedAtMs: state.startedAtMs,
        stoppedAtMs: state.stoppedAtMs,
        completion,
        platform: state.platform,
        config: { ...config, obsPassword: undefined },
        channels: state.channels,
        permissions: state.permissions,
        devices: state.devices,
        files: state.files,
        gaps: state.gaps,
        clockAnchors: state.clockAnchors,
        updatedAt: new Date().toISOString(),
      }),
    )
    .catch(emergency);
  return persistQueue;
}
async function persistStatus() {
  await mkdir(userData, { recursive: true });
  await atomicJson(statusPath, pub()).catch(() => {});
}
function gap(channel, reason) {
  const old = state.gaps.findLast?.(
    (x) => x.channel === channel && !x.endUtcMs,
  );
  if (!old) {
    state.gaps.push({
      channel,
      startUtcMs: Date.now(),
      startMonotonicMs: performance.now(),
      endUtcMs: null,
      reason,
    });
    event("gap_started", { channel, reason });
  }
}
function endGap(channel) {
  const old = state.gaps.findLast?.(
    (x) => x.channel === channel && !x.endUtcMs,
  );
  if (old) {
    old.endUtcMs = Date.now();
    old.endMonotonicMs = performance.now();
    event("gap_ended", { channel });
  }
}
async function addFile(kind, path, start, end, extra = {}) {
  const info = await stat(path);
  const row = {
    id: randomUUID(),
    kind,
    path: relative(state.sessionDir, path),
    startUtcMs: start.utcMs,
    endUtcMs: end.utcMs,
    startMonotonicMs: start.monotonicMs,
    endMonotonicMs: end.monotonicMs,
    sizeBytes: info.size,
    ...extra,
  };
  state.files.push(row);
  event("segment_completed", { kind, path: row.path });
  await persist();
}
const auth = (password, salt, challenge) => {
  const h = (v) => createHash("sha256").update(v).digest("base64");
  return h(h(password + salt) + challenge);
};
async function obsPassword() {
  try {
    return safeStorage.decryptString(await readFile(secretPath));
  } catch {}
  try {
    return JSON.parse(
      await readFile(
        join(
          app.getPath("userData"),
          "../obs-studio/plugin_config/obs-websocket/config.json",
        ),
        "utf8",
      ),
    ).server_password;
  } catch {
    return null;
  }
}
async function savePassword(value) {
  if (!value) return;
  await mkdir(dirname(secretPath), { recursive: true });
  await writeFile(secretPath, safeStorage.encryptString(value));
}
async function obsRequest(type, data) {
  const password = await obsPassword();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:4455"),
      id = randomUUID(),
      timer = setTimeout(() => {
        ws.close();
        reject(new Error("OBS WebSocket timeout"));
      }, 5000);
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("OBSへ接続できません"));
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.op === 0) {
        if (m.d.authentication && !password) {
          clearTimeout(timer);
          ws.close();
          return reject(new Error("OBS WebSocketパスワードが必要です"));
        }
        ws.send(
          JSON.stringify({
            op: 1,
            d: {
              rpcVersion: 1,
              eventSubscriptions: 0,
              ...(m.d.authentication
                ? {
                    authentication: auth(
                      password,
                      m.d.authentication.salt,
                      m.d.authentication.challenge,
                    ),
                  }
                : {}),
            },
          }),
        );
      } else if (m.op === 2)
        ws.send(
          JSON.stringify({
            op: 6,
            d: {
              requestType: type,
              requestId: id,
              ...(data ? { requestData: data } : {}),
            },
          }),
        );
      else if (m.op === 7 && m.d.requestId === id) {
        clearTimeout(timer);
        ws.close();
        m.d.requestStatus.result
          ? resolve(m.d.responseData ?? {})
          : reject(new Error(m.d.requestStatus.comment || type));
      }
    };
  });
}
async function profile(name, value) {
  if (value === undefined) {
    const r = await obsRequest("GetProfileParameter", {
      parameterCategory: "AdvOut",
      parameterName: name,
    });
    return r.parameterValue ?? r.defaultParameterValue ?? "";
  }
  return obsRequest("SetProfileParameter", {
    parameterCategory: "AdvOut",
    parameterName: name,
    parameterValue: String(value),
  });
}
async function startObs() {
  const current = await obsRequest("GetRecordStatus");
  if (current.outputActive)
    throw new Error("既存のOBS録画が終了するまで待機します");
  let format;
  try { obsFormatKey = "RecFormat2"; format = String(await profile(obsFormatKey)).toLowerCase(); }
  catch { obsFormatKey = "RecFormat"; format = String(await profile(obsFormatKey)).toLowerCase(); }
  if (format !== "mkv") {
    obsOriginalFormat = format;
    await profile(obsFormatKey, "mkv");
    format = String(await profile(obsFormatKey)).toLowerCase();
    if (format !== "mkv") throw new Error("OBSの録画形式をMKVへ変更できませんでした");
  }
  const vc = await obsRequest("GetVirtualCamStatus");
  if (!vc.outputActive) {
    await obsRequest("StartVirtualCam");
    virtualCamOwned = true;
  }
  const dir = join(state.sessionDir, "obs");
  obsOriginalDir = await obsRequest("GetRecordDirectory")
    .then((x) => x.recordDirectory)
    .catch(() => profile("RecFilePath"));
  await obsRequest("SetRecordDirectory", { recordDirectory: dir }).catch(() =>
    profile("RecFilePath", dir),
  );
  const requested = { utcMs: Date.now(), monotonicMs: performance.now() };
  await obsRequest("StartRecord");
  const confirmed = await obsRequest("GetRecordStatus");
  if (!confirmed.outputActive) throw new Error("OBS録画開始を確認できません");
  obsOwned = true;
  obsOwnershipUncertain = false;
  obsSegmentStart = requested;
  setChannel("obs", "recording", "MKVを保存中");
  event("obs_started", {
    requestedAt: requested,
    confirmedAt: clockAnchor(),
    outputDuration: confirmed.outputDuration,
  });
}
async function splitObs() {
  if (!obsOwned || obsOwnershipUncertain) return;
  const before = await snapshotObsDir();
  const boundary = clockAnchor();
  await obsRequest("SplitRecordFile");
  await new Promise((r) => setTimeout(r, 1200));
  const after = await snapshotObsDir();
  const completed = [...before, ...after]
    .filter((x) => !after.some((y) => y.path === x.path && y.size !== x.size))
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (
    completed &&
    !state.files.some(
      (x) => x.path === relative(state.sessionDir, completed.path),
    )
  ) {
    await indexMedia("obs", completed.path, obsSegmentStart, boundary, {
      plannedBoundaryUtcMs: boundary.utcMs,
    });
  }
  obsSegmentStart = boundary;
  event("segment_boundary", { kind: "obs", at: boundary });
}
async function stopObs() {
  if (!obsOwned || obsOwnershipUncertain) {
    if (obsOwnershipUncertain)
      event("obs_stop_skipped", { reason: "ownership_uncertain" });
    if (obsOriginalDir)
      await obsRequest("SetRecordDirectory", { recordDirectory: obsOriginalDir })
        .catch(() => profile("RecFilePath", obsOriginalDir));
    if (obsOriginalFormat && obsFormatKey)
      await profile(obsFormatKey, obsOriginalFormat).catch(() => {});
    obsOriginalDir = obsOriginalFormat = obsFormatKey = null;
    if (virtualCamOwned) {
      await obsRequest("StopVirtualCam").catch(() => {});
      virtualCamOwned = false;
    }
    return;
  }
  const start = obsSegmentStart ?? clockAnchor(),
    requested = clockAnchor(),
    result = await obsRequest("StopRecord");
  obsOwned = false;
  if (result.outputPath)
    await indexMedia("obs", result.outputPath, start, requested, {
      stopResponseAt: clockAnchor(),
    });
  if (obsOriginalDir)
    await obsRequest("SetRecordDirectory", {
      recordDirectory: obsOriginalDir,
    }).catch(() => profile("RecFilePath", obsOriginalDir));
  if (obsOriginalFormat && obsFormatKey) {
    await profile(obsFormatKey, obsOriginalFormat).catch(() => {});
    obsOriginalFormat = obsFormatKey = null;
  }
  obsOriginalDir = null;
  if (virtualCamOwned) {
    await obsRequest("StopVirtualCam").catch(() => {});
    virtualCamOwned = false;
  }
  setChannel("obs", "connected", "保存完了");
}
async function snapshotObsDir() {
  const dir = join(state.sessionDir, "obs");
  return Promise.all(
    (await readdir(dir).catch(() => []))
      .filter((x) => /\.mkv$/i.test(x))
      .map(async (x) => {
        const path = join(dir, x),
          s = await stat(path);
        return { path, size: s.size, mtime: s.mtimeMs };
      }),
  );
}
async function run(command, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }),
      o = [],
      e = [];
    c.stdout.on("data", (x) => o.push(x));
    c.stderr.on("data", (x) => e.push(x));
    c.on("error", reject);
    c.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(o).toString())
        : reject(
            new Error(
              Buffer.concat(e).toString() ||
                `${basename(command)} exited ${code}`,
            ),
          ),
    );
  });
}
async function probe(path) {
  return new Promise((resolve) => {
    const c = spawn(
        ffmpegPath,
        ["-hide_banner", "-i", path, "-f", "null", "-"],
        { stdio: ["ignore", "ignore", "pipe"] },
      ),
      err = [];
    c.stderr.on("data", (x) => err.push(x));
    c.on("error", () => resolve({}));
    c.on("close", () => {
      const text = Buffer.concat(err).toString(),
        duration = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/),
        video = text.match(/Video: ([^,]+).*?(\d{2,5})x(\d{2,5})/);
      resolve({
        durationMs: duration
          ? (Number(duration[1]) * 3600 +
              Number(duration[2]) * 60 +
              Number(duration[3])) *
            1000
          : null,
        codec:
          video?.[1]?.trim() ??
          text.match(/Audio: ([^,]+)/)?.[1]?.trim() ??
          null,
        width: video ? Number(video[2]) : null,
        height: video ? Number(video[3]) : null,
      });
    });
  });
}
async function indexMedia(kind, path, start, end, extra = {}) {
  const p = await probe(path);
  await addFile(kind, path, start, end, {
    container: extname(path).slice(1),
    codec: p.codec ?? null,
    mediaDurationMs: p.durationMs ?? null,
    width: p.width ?? null,
    height: p.height ?? null,
    ...extra,
  });
}
async function openCamera() {
  cameraPath = join(
    state.sessionDir,
    "camera",
    `camera-${String(++cameraIndex).padStart(4, "0")}.webm`,
  );
  cameraHandle = await open(cameraPath, "w");
  cameraStart = null;
}
async function closeCamera(details = {}) {
  if (!cameraHandle) return;
  const h = cameraHandle,
    path = cameraPath,
    start = cameraStart ?? clockAnchor();
  cameraHandle = null;
  await writeQueue;
  await h.close();
  const s = await stat(path);
  if (!s.size) {
    await unlink(path);
    return;
  }
  const final = `${path}.final.webm`;
  await run(ffmpegPath, ["-y", "-i", path, "-c", "copy", final]);
  await rename(final, path);
  await indexMedia("camera", path, start, clockAnchor(), details);
}
async function openAudio() {
  audioPath = join(
    state.sessionDir,
    "audio",
    `audio-${String(++audioIndex).padStart(4, "0")}.pcm`,
  );
  audioHandle = await open(audioPath, "w");
  audioStart = null;
  audioSamples = 0;
}
async function closeAudio() {
  if (!audioHandle) return;
  const h = audioHandle,
    path = audioPath,
    start = audioStart ?? clockAnchor(),
    samples = audioSamples;
  audioHandle = null;
  await writeQueue;
  await h.close();
  if (!samples) {
    await unlink(path);
    return;
  }
  const wav = path.replace(/\.pcm$/, ".wav"),
    data = await readFile(path);
  await writeFile(wav, Buffer.concat([wavHeader(data.length), data]));
  await unlink(path);
  await addFile("audio", wav, start, clockAnchor(), {
    container: "wav",
    codec: "pcm_s16le",
    sampleRate: 48000,
    channels: 1,
    bitsPerSample: 16,
    sampleCount: samples,
    mediaDurationMs: samples / 48,
  });
}
async function probeInputHelper(request = false) {
  return new Promise((resolve) => {
    const child = spawn(helperPath, request ? ["--request-permission"] : [], { stdio: ["ignore", "pipe", "ignore"] });
    let buffer = "", settled = false;
    const finish = (value) => { if (settled) return; settled = true; child.kill("SIGTERM"); resolve(value); };
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n"); buffer = lines.pop();
      for (const line of lines) try {
        const row = JSON.parse(line);
        if (row.type === "permission") return finish({ granted: Boolean(row.granted), accessibility: Boolean(row.accessibility), inputMonitoring: Boolean(row.input_monitoring) });
      } catch {}
    });
    child.once("close", () => finish({ granted: false }));
    setTimeout(() => finish({ granted: false }), 3000);
  });
}
async function inputPreflight(prompt = false) {
  if (prompt) systemPreferences.isTrustedAccessibilityClient(true);
  const permission = await probeInputHelper(prompt), trusted = permission.granted;
  state.permissions.accessibility = trusted ? "granted" : "denied";
  if (!trusted) {
    setChannel(
      "input",
      "permission_wait",
      "システム設定 → プライバシーとセキュリティ → アクセシビリティで許可してください",
    );
    return false;
  }
  return true;
}
function startInput() {
  if (input || !raw) return;
  inputStopping = false;
  const c = spawn(helperPath, [], { stdio: ["ignore", "pipe", "pipe"] });
  input = c;
  let buffer = "";
  c.stdout.on("data", (x) => {
    buffer += x;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines)
      try {
        const v = JSON.parse(line);
        if (v.type === "permission") {
          state.permissions.accessibility = v.granted ? "granted" : "denied";
          continue;
        }
        inputHeartbeat = Date.now();
        raw.input(v);
        setChannel("input", "recording", "CGEventTapデータを保存中");
        endGap("input");
      } catch (e) {
        event("input_invalid", { reason: String(e) });
      }
  });
  c.stderr.on("data", (x) =>
    event("input_helper_error", { reason: String(x).slice(0, 1000) }),
  );
  c.on("close", (code) => {
    input = null;
    inputHeartbeat = 0;
    if (!inputStopping) {
      setChannel("input", "disconnected", `操作ログヘルパー終了 (${code})`);
      gap("input", "helper_stopped");
    }
  });
}
async function stopInput() {
  if (!input) return;
  inputStopping = true;
  const c = input;
  input = null;
  c.kill("SIGTERM");
  await new Promise((r) => {
    const t = setTimeout(r, 3000);
    c.once("close", () => {
      clearTimeout(t);
      r();
    });
  });
}
async function aw(path) {
  const r = await fetch(`http://127.0.0.1:5600/api/0${path}`, {
    signal: AbortSignal.timeout(2500),
  });
  if (!r.ok) throw new Error(`ActivityWatch ${r.status}`);
  return r.json();
}
async function collectActivity(force = false) {
  if (!raw || (!force && state.state !== "recording")) return;
  try {
    const buckets = await aw("/buckets"),
      ids = Object.keys(buckets).filter((x) =>
        /aw-watcher-(window|afk)/.test(x),
      );
    if (
      !ids.some((x) => x.includes("window")) ||
      !ids.some((x) => x.includes("afk"))
    )
      throw new Error("window/AFK watcherを確認できません");
    const end = new Date(),
      start = new Date(Math.max(state.startedAtMs, Date.now() - 20_000));
    for (const id of ids) {
      const q = new URLSearchParams({
        starttime: start.toISOString(),
        endtime: end.toISOString(),
      });
      await raw.activity(
        id,
        await aw(`/buckets/${encodeURIComponent(id)}/events?${q}`),
      );
    }
    setChannel("activitywatch", "recording", `${ids.length} bucketsを保存中`);
    endGap("activitywatch");
  } catch (e) {
    setChannel("activitywatch", "reconnecting", String(e));
    gap("activitywatch", String(e));
  }
}
async function locateApps() {
  const candidates = {
    obs: [
      "/Applications/OBS.app",
      join(app.getPath("home"), "Applications/OBS.app"),
    ],
    aw: [
      "/Applications/ActivityWatch.app",
      join(app.getPath("home"), "Applications/ActivityWatch.app"),
    ],
  };
  const found = {};
  for (const [key, list] of Object.entries(candidates))
    for (const path of list)
      try {
        await access(path);
        found[key] = path;
        break;
      } catch {}
  return found;
}
function launch(path) {
  if (path)
    spawn("open", ["-a", path], { detached: true, stdio: "ignore" }).unref();
}
async function preflight() {
  const apps = await locateApps();
  try {
    await aw("/buckets");
    setChannel("activitywatch", "connected", "window/AFK確認中");
  } catch {
    setChannel(
      "activitywatch",
      "reconnecting",
      "ActivityWatchを起動しています",
    );
    launch(apps.aw);
    return false;
  }
  try {
    const b = await aw("/buckets"),
      ids = Object.keys(b);
    if (
      !ids.some((x) => /aw-watcher-window/.test(x)) ||
      !ids.some((x) => /aw-watcher-afk/.test(x))
    )
      return false;
  } catch {
    return false;
  }
  try {
    const v = await obsRequest("GetVersion");
    setChannel(
      "obs",
      "connected",
      `OBS WebSocket ${v.obsWebSocketVersion ?? ""}`,
    );
    const r = await obsRequest("GetRecordStatus");
    if (r.outputActive) {
      setChannel("obs", "connected", "既存録画の終了待ち");
      return false;
    }
  } catch {
    setChannel("obs", "reconnecting", "OBSを起動しています");
    launch(apps.obs);
    return false;
  }
  if (!(await inputPreflight(false))) return false;
  if (!mediaReady) {
    setChannel("camera", "permission_wait", "カメラ確認待ち");
    setChannel("audio", "permission_wait", "マイク確認待ち");
    win?.webContents.send("recorder:command", "probe-media");
    return false;
  }
  return true;
}
async function startRecording() {
  if (
    state.state === "recording" ||
    state.state === "stopping" ||
    manualStopped
  )
    return pub();
  state.state = "waiting";
  state.message = "すべての記録系統を確認しています";
  if (!(await preflight())) {
    await persistStatus();
    return pub();
  }
  const free = await statfs(config.storageRoot)
    .then((x) => x.bavail * x.bsize)
    .catch(() => 0);
  if (free < 10 * 1024 ** 3) {
    state.message = "空き容量が10 GiB未満です";
    return pub();
  }
  const id = randomUUID(),
    started = clockAnchor(),
    dir = join(config.storageRoot, sessionName(started.utcMs, id));
  for (const name of ["camera", "audio", "obs", "raw"])
    await mkdir(join(dir, name), { recursive: true });
  Object.assign(state, {
    state: "starting",
    sessionId: id,
    sessionDir: dir,
    startedAtMs: started.utcMs,
    stoppedAtMs: null,
    events: [],
    files: [],
    gaps: [],
    clockAnchors: [started],
  });
  raw = new RawStudy(dir, {
    participant_id: config.participantId,
    session_id: id,
  });
  await raw.append("control_events.jsonl", {
    type: "session_start",
    source: "research_recorder",
    timestamp_ms: started.utcMs,
    monotonic_ms: started.monotonicMs,
  });
  startInput();
  try {
    await startObs();
    await openCamera();
    await openAudio();
    const ready = new Promise((resolve, reject) => {
      mediaReadyResolve = resolve;
      setTimeout(
        () => reject(new Error("メディア保存開始を確認できません")),
        15_000,
      );
    });
    win.webContents.send("recorder:command", "start-media");
    await ready;
    state.state = "recording";
    state.message = "研究用生データを保存しています";
    await persist();
    timers = [
      setInterval(collectActivity, 5000),
      setInterval(splitObs, config.segmentMs),
      setInterval(anchor, 60_000),
      setInterval(health, 5000),
      setInterval(checkDisk, 30_000),
    ];
    timers.forEach((x) => x.unref?.());
    return pub();
  } catch (e) {
    event("startup_failed", { reason: String(e) });
    state.message = String(e);
    await stopRecording("startup_failed");
    return pub();
  }
}
async function anchor() {
  const now = clockAnchor(),
    shift = clockShift(previousAnchor, now);
  previousAnchor = now;
  state.clockAnchors.push(now);
  if (shift) event("system_clock_changed", shift);
  await persist();
}
async function health() {
  if (inputHeartbeat && Date.now() - inputHeartbeat > 3500) {
    setChannel("input", "reconnecting", "heartbeat途絶");
    gap("input", "heartbeat_timeout");
  }
  if (!input && !inputStopping) startInput();
  try {
    const s = await obsRequest("GetRecordStatus");
    if (obsOwned && !s.outputActive) {
      obsOwnershipUncertain = true;
      setChannel("obs", "disconnected", "録画状態が変化しました");
      gap("obs", "recording_state_changed");
    }
  } catch {
    if (obsOwned) obsOwnershipUncertain = true;
    setChannel("obs", "reconnecting", "OBS切断");
    gap("obs", "websocket_disconnected");
  }
  await collectActivity();
}
async function checkDisk() {
  const free = await statfs(config.storageRoot)
    .then((x) => x.bavail * x.bsize)
    .catch(() => 0);
  if (free < 10 * 1024 ** 3) {
    event("disk_low", { freeBytes: free });
    await stopRecording("disk_full");
  }
}
async function stopRecording(completion = "complete") {
  manualStopped = completion === "complete" || completion === "disk_full";
  if (!["recording", "starting"].includes(state.state)) return pub();
  state.state = "stopping";
  timers.forEach(clearInterval);
  timers = [];
  win?.webContents.send("recorder:command", "stop-media");
  await new Promise((r) => setTimeout(r, 1500));
  await Promise.allSettled([
    closeCamera(),
    closeAudio(),
    stopObs(),
    collectActivity(true),
    stopInput(),
  ]);
  if (raw) {
    await raw.append("control_events.jsonl", {
      type: "session_stop",
      source: "research_recorder",
      timestamp_ms: Date.now(),
    });
    await raw.exportCsv(state.files, state.gaps);
    raw = null;
  }
  state.stoppedAtMs = Date.now();
  state.state =
    completion === "complete"
      ? "idle"
      : completion === "startup_failed"
        ? "waiting"
        : "failed";
  state.message =
    completion === "complete"
      ? "保存を完了しました"
      : `セッション終了: ${completion}`;
  await writeQueue;
  await persistQueue;
  await persist(completion);
  return pub();
}
async function recover() {
  for (const d of await readdir(config.storageRoot, {
    withFileTypes: true,
  }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    const path = join(config.storageRoot, d.name, "session.json");
    try {
      const v = JSON.parse(await readFile(path, "utf8"));
      if (v.completion === "recording") {
        const recovery = join(
          config.storageRoot,
          d.name,
          `recovery-${Date.now()}.json`,
        );
        await writeFile(
          recovery,
          JSON.stringify(
            {
              detectedAt: new Date().toISOString(),
              completion: "interrupted",
              preservedSession: "session.json",
            },
            null,
            2,
          ),
        );
      }
    } catch {}
  }
}
ipcMain.handle("recorder:get-status", () => pub());
ipcMain.handle("recorder:request-accessibility", async () => {
  systemPreferences.isTrustedAccessibilityClient(true);
  let permission = await probeInputHelper(true), granted = permission.granted;
  if (!granted) {
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    permission = await probeInputHelper(); granted = permission.granted;
  }
  state.permissions.accessibility = granted ? "granted" : "denied";
  setChannel("input", granted ? "connected" : "permission_wait", granted ? "Accessibility権限を確認しました" : "Research Recorderを一覧へ追加してオンにし、アプリを再起動してください");
  await persistStatus();
  return { granted, accessibility: permission.accessibility, inputMonitoring: permission.inputMonitoring, appPath: app.getPath("exe"), helperPath };
});
ipcMain.handle("recorder:run-diagnostics", async () => {
  if (["recording", "starting", "stopping"].includes(state.state))
    throw new Error("記録中は事前テストを実行できません");
  const checkedAt = new Date().toISOString();
  const activitywatch = await (async () => {
    const apps = await locateApps();
    let lastError;
    for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const buckets = await aw("/buckets");
      const ids = Object.keys(buckets).filter((id) => /aw-watcher-(window|afk)/.test(id));
      const detail = {};
      for (const id of ids) {
        const q = new URLSearchParams({ starttime: new Date(Date.now() - 120_000).toISOString(), endtime: new Date().toISOString(), limit: "1" });
        const rows = await aw(`/buckets/${encodeURIComponent(id)}/events?${q}`);
        detail[/window/.test(id) ? "window" : "afk"] = { bucketId: id, recentEvent: Array.isArray(rows) && rows.length > 0, latestTimestamp: rows?.[0]?.timestamp ?? null };
      }
      if (detail.window?.recentEvent && detail.afk?.recentEvent)
        return { ok: true, message: "window/AFK watcherへ接続しました", detail };
      lastError = new Error("windowまたはAFK watcherから直近イベントを取得できません");
    } catch (error) { lastError = error; }
      if (attempt === 0) launch(apps.aw);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return { ok: false, message: String(lastError), detail: {} };
  })();
  const obs = await (async () => {
    try {
      const version = await obsRequest("GetVersion"), record = await obsRequest("GetRecordStatus");
      const format = String(await profile("RecFormat2").catch(() => profile("RecFormat"))).toLowerCase();
      return { ok: !record.outputActive, warning: format !== "mkv", message: record.outputActive ? "既存のOBS録画が動作中です" : format === "mkv" ? "OBS WebSocket接続・MKV設定を確認しました" : `OBS WebSocket接続済み（録画時に${format}からMKVへ一時切替）`, detail: { websocketVersion: version.obsWebSocketVersion ?? null, obsVersion: version.obsVersion ?? null, recordActive: Boolean(record.outputActive), recordFormat: format, recordingFormat: "mkv", restoresOriginalFormat: true } };
    } catch (error) { return { ok: false, message: String(error), detail: {} }; }
  })();
  const inputPermission = await probeInputHelper(), accessibility = inputPermission.granted;
  const input = await new Promise((resolve) => {
    if (!accessibility) return resolve({ ok: false, message: "CGEventTapを作成できません。Accessibilityと入力監視を確認してください", detail: { accessibilitySettings: "プライバシーとセキュリティ → アクセシビリティ", inputMonitoringSettings: "プライバシーとセキュリティ → 入力監視" } });
    const child = spawn(helperPath, [], { stdio: ["ignore", "pipe", "pipe"] });
    const counts = { heartbeat: 0, keydown: 0, click: 0, scroll: 0, movement: 0 };
    let buffer = "", stderr = "", done = false;
    const finish = (message) => { if (done) return; done = true; child.kill("SIGTERM"); resolve({ ok: counts.heartbeat > 0, message, detail: { counts } }); };
    child.stdout.on("data", (chunk) => { buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop(); for (const line of lines) try { const row = JSON.parse(line); if (Object.hasOwn(counts, row.type)) counts[row.type]++; } catch {} });
    child.stderr.on("data", (chunk) => (stderr += String(chunk).slice(0, 500)));
    child.once("close", () => finish(stderr || "操作ログヘルパーが早期終了しました"));
    setTimeout(() => finish("5秒間のheartbeatと操作イベントを確認しました"), 5000);
  });
  return { checkedAt, activitywatch, obs, input, accessibility };
});
ipcMain.handle("recorder:save-config", async (_e, v) => {
  if (state.state === "recording")
    throw new Error("記録中は設定を変更できません");
  if (v.obsPassword) await savePassword(v.obsPassword);
  config = normalizeRecorderConfig(
    { ...config, ...v, setupComplete: true },
    app.getPath("documents"),
  );
  state.config = config;
  saved = true;
  manualStopped = false;
  mediaReady = false;
  await mkdir(userData, { recursive: true });
  await atomicJson(configPath, config);
  await inputPreflight(true);
  return pub();
});
ipcMain.handle("recorder:media-preflight", async (_e, d) => {
  mediaReady = Boolean(d?.camera && d?.audio);
  state.permissions.camera = d?.camera
    ? "granted"
    : (d?.cameraPermission ?? "denied");
  state.permissions.microphone = d?.audio
    ? "granted"
    : (d?.microphonePermission ?? "denied");
  state.devices = d?.devices ?? {};
  setChannel(
    "camera",
    d?.camera ? "connected" : "permission_wait",
    d?.cameraDetail ?? "OBS Virtual Camera待ち",
  );
  setChannel(
    "audio",
    d?.audio ? "connected" : "permission_wait",
    d?.audioDetail ?? "マイク待ち",
  );
  return pub();
});
ipcMain.handle("recorder:start", () => {
  manualStopped = false;
  return startRecording();
});
ipcMain.handle("recorder:stop", () => stopRecording());
ipcMain.handle("recorder:quit", async () => {
  await stopRecording();
  quitting = true;
  app.quit();
});
ipcMain.handle("recorder:open-folder", () =>
  shell.openPath(state.sessionDir ?? config.storageRoot),
);
ipcMain.handle("recorder:media-ready", async (_e, d) => {
  state.devices = d;
  setChannel(
    "camera",
    d.camera.qualityMet ? "recording" : "quality_low",
    d.camera.detail,
  );
  setChannel(
    "audio",
    d.audio.qualityMet ? "recording" : "quality_low",
    d.audio.detail,
  );
  mediaReadyResolve?.();
  mediaReadyResolve = null;
  await persist();
  return pub();
});
ipcMain.handle("recorder:media-failed", async (_e, d) => {
  setChannel(d.channel, "reconnecting", d.reason);
  gap(d.channel, d.reason);
  return pub();
});
ipcMain.handle("recorder:media-recovered", async (_e, d) => {
  setChannel(d.channel, "recording", "再接続後のデータを保存中");
  endGap(d.channel);
  event("channel_reconnected", { channel: d.channel });
  await persist();
  return pub();
});
ipcMain.handle("recorder:camera-chunk", (_e, d) => {
  if (d.sessionId !== state.sessionId || !cameraHandle) return;
  const h = cameraHandle;
  if (!cameraStart)
    cameraStart = { utcMs: d.utcMs, monotonicMs: d.monotonicMs };
  writeQueue = writeQueue
    .then(() => h.write(Buffer.from(d.bytes)))
    .catch(emergency);
  return writeQueue;
});
ipcMain.handle("recorder:rotate-camera", async (_e, d) => {
  await closeCamera(d);
  if (state.state === "recording") {
    await openCamera();
    event("segment_boundary", {
      kind: "camera",
      plannedBoundaryUtcMs: d.plannedBoundaryUtcMs,
    });
  }
  return pub();
});
ipcMain.handle("recorder:audio-chunk", async (_e, d) => {
  if (d.sessionId !== state.sessionId || !audioHandle) return;
  let rest = Buffer.from(d.bytes);
  if (!audioStart) audioStart = { utcMs: d.utcMs, monotonicMs: d.monotonicMs };
  while (rest.length) {
    const split = splitPcm16(rest, 28_800_000 - audioSamples),
      h = audioHandle;
    writeQueue = writeQueue.then(() => h.write(split.part)).catch(emergency);
    audioSamples += split.samples;
    rest = split.rest;
    if (audioSamples === 28_800_000) {
      await closeAudio();
      if (state.state === "recording") await openAudio();
    }
  }
  return pub();
});
app.on("before-quit", (e) => {
  if (!quitting && ["recording", "starting"].includes(state.state)) {
    e.preventDefault();
    stopRecording().finally(() => {
      quitting = true;
      app.quit();
    });
  }
});
app.on("window-all-closed", () => {});
app.on("activate", () => win?.show());
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});
app
  .whenReady()
  .then(async () => {
    await mkdir(config.storageRoot, { recursive: true });
    await recover();
    const local = (x) => x.startsWith("file:");
    session.defaultSession.setPermissionCheckHandler(
      (_w, p, o) => p === "media" && local(o),
    );
    session.defaultSession.setPermissionRequestHandler((w, p, cb) =>
      cb(p === "media" && local(w.getURL())),
    );
    powerMonitor.on("suspend", () => gap("system", "sleep"));
    powerMonitor.on("resume", () => endGap("system"));
    win = new BrowserWindow({
      width: 1120,
      height: 900,
      show: !smoke,
      title: "研究レコーダー",
      webPreferences: {
        preload: join(root, "recorder-preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.on("close", (e) => {
      if (!quitting) {
        e.preventDefault();
        win.hide();
      }
    });
    await win.loadFile(join(root, "dist", "recorder.html"));
    tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip("研究レコーダー");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "記録画面を開く", click: () => win.show() },
        { label: "停止して保存", click: () => stopRecording() },
        { type: "separator" },
        {
          label: "終了",
          click: () => {
            quitting = true;
            stopRecording().finally(() => app.quit());
          },
        },
      ]),
    );
    if (smoke) {
      console.log("RECORDER_PACKAGE_SMOKE_OK");
      quitting = true;
      app.quit();
      return;
    }
    setInterval(() => {
      if (saved && !manualStopped && state.state === "waiting")
        startRecording().catch(emergency);
    }, 5000).unref();
    if (saved) {
      manualStopped = false;
      startRecording();
    }
    if (stopAfter)
      setTimeout(
        () =>
          stopRecording().finally(() => {
            quitting = true;
            app.quit();
          }),
        stopAfter,
      ).unref();
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
