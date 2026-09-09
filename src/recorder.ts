import "./recorder.css";
declare global {
  interface Window {
    researchRecorder: any;
  }
}
const api = window.researchRecorder,
  $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;
document.querySelector("#app")!.innerHTML =
  `<main><header><div><span class="eyebrow">RAW DATA CAPTURE · macOS</span><h1>研究レコーダー</h1><p class="muted">分析を行わず、研究用の原データだけを保存します。</p></div><div><div class="statusline" id="overall">準備中</div><div class="muted" id="elapsed">00:00:00</div></div></header><nav><button class="tab active" data-page="record">記録</button><button class="tab" data-page="test">計測前テスト</button></nav><div id="recordPage"><section class="hero"><div class="preview"><video id="preview" autoplay muted playsinline></video></div><div class="cards" id="cards"></div></section><div class="toolbar"><button class="primary" id="start">記録開始</button><button id="stop">停止して保存</button><button id="folder">保存先を開く</button><button class="danger" id="quit">終了</button></div><section class="panel"><h2>記録設定</h2><div class="settings"><label>参加者ID<input id="participant"></label><label>マイク<select id="microphone"></select></label><label class="wide">保存先<input id="storage"></label><label>カメラ<select id="camera"></select></label><label>OBS WebSocketパスワード<input id="obsPassword" type="password" placeholder="変更時のみ入力"></label></div><div class="toolbar"><button id="permissions">カメラ・マイクを許可</button><button id="save">設定を保存</button><span class="muted" id="message"></span></div><p class="muted">操作ログにはキー内容・キーコード・入力文字列・クリップボードを保存しません。Accessibilityはシステム設定の「プライバシーとセキュリティ」で許可します。</p></section><section class="panel"><h2>音声レベル</h2><div class="meter"><i id="level"></i></div></section><section class="panel"><h2>記録イベント</h2><div class="events" id="events"></div></section></div><div id="testPage" hidden><section class="panel"><h2>計測前テスト</h2><p class="muted">セッションを開始せず、入力が届くか確認します。映像・音声・結果は保存されません。操作ログ確認中の5秒間にキー入力、クリック、スクロール、マウス移動を行ってください。</p><div class="toolbar"><button class="primary" id="runTest">すべてテスト</button><button id="stopTest" disabled>メディアテスト停止</button><span class="muted" id="testMessage">未実行</span></div></section><section class="test-grid"><div class="panel test-card"><h2>OBS画面録画</h2><strong id="testObs">未実行</strong><pre id="testObsDetail"></pre></div><div class="panel test-card"><h2>ActivityWatch</h2><strong id="testAw">未実行</strong><pre id="testAwDetail"></pre></div><div class="panel test-card"><h2>操作ログ</h2><strong id="testInput">未実行</strong><pre id="testInputDetail"></pre></div><div class="panel test-card"><h2>OBS Virtual Camera</h2><strong id="testCamera">未実行</strong><video id="testPreview" autoplay muted playsinline></video><pre id="testCameraDetail"></pre></div><div class="panel test-card"><h2>マイク</h2><strong id="testMic">未実行</strong><div class="meter"><i id="testLevel"></i></div><pre id="testMicDetail"></pre></div></section></div></main>`;
let cameraStream: MediaStream | null = null,
  audioStream: MediaStream | null = null,
  recorder: MediaRecorder | null = null,
  audioContext: AudioContext | null = null,
  processor: AudioWorkletNode | null = null,
  recording = false,
  segmentTimer = 0,
  cameraStart = 0,
  sessionId: string | null = null,
  activeCameraId: string | null = null,
  activeMicId: string | null = null,
  activeSegmentMs = 600_000,
  cameraChunkQueue: Promise<unknown> = Promise.resolve();
let testCameraStream: MediaStream | null = null,
  testAudioStream: MediaStream | null = null,
  testAudioContext: AudioContext | null = null,
  testMeterFrame = 0;
const reconnectTimers: Record<"camera" | "audio", number | null> = {
  camera: null,
  audio: null,
};
const labels: any = {
    activitywatch: "ActivityWatch",
    input: "操作ログ",
    obs: "OBS画面録画",
    camera: "カメラ単独映像",
    audio: "マイク音声",
  },
  states: any = {
    connected: "接続済み",
    recording: "データ保存中",
    permission_wait: "権限待ち",
    disconnected: "切断",
    reconnecting: "再接続中",
    quality_low: "指定品質未満",
    save_failed: "保存失敗",
    waiting: "待機",
  };
function render(s: any) {
  $("overall").textContent =
    s.state === "recording"
      ? "記録中"
      : s.state === "stopping"
        ? "保存中"
        : s.state === "failed"
          ? "保存失敗"
          : "準備待ち";
  $("overall").className =
    `statusline ${s.state === "recording" ? "ok" : s.state === "failed" ? "bad" : "warn"}`;
  const sec = s.startedAtMs
    ? Math.floor((Date.now() - s.startedAtMs) / 1000)
    : 0;
  $("elapsed").textContent =
    `${String(Math.floor(sec / 3600)).padStart(2, "0")}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  $("cards").replaceChildren(
    ...Object.entries(s.channels).map(([k, v]: any) => {
      const e = document.createElement("div");
      e.className = "card";
      e.innerHTML = `<div><span>${labels[k]}</span><strong>${states[v.state] ?? v.state}</strong></div><small></small>`;
      e.querySelector("small")!.textContent = v.detail ?? "";
      return e;
    }),
  );
  $("events").replaceChildren(
    ...s.events
      .slice(-30)
      .reverse()
      .map((v: any) => {
        const e = document.createElement("div");
        e.textContent = `${new Date(v.at).toLocaleTimeString()} ${v.type}${v.reason ? " · " + v.reason : ""}`;
        return e;
      }),
  );
  $("message").textContent = s.message ?? "";
  $<HTMLButtonElement>("stop").disabled = s.state !== "recording";
  $<HTMLButtonElement>("start").disabled = [
    "recording",
    "starting",
    "stopping",
  ].includes(s.state);
}
async function devices() {
  const all = await navigator.mediaDevices.enumerateDevices(),
    mics = all.filter((x) => x.kind === "audioinput"),
    cams = all.filter(
      (x) => x.kind === "videoinput" && /obs.*virtual camera/i.test(x.label),
    );
  const fill = (id: string, list: MediaDeviceInfo[], empty: string) => {
    const s = $<HTMLSelectElement>(id),
      old = s.value;
    s.replaceChildren(
      ...(list.length
        ? list.map((x) => new Option(x.label || empty, x.deviceId))
        : [new Option(empty, "")]),
    );
    if ([...s.options].some((x) => x.value === old)) s.value = old;
  };
  fill("microphone", mics, "マイクが見つかりません");
  fill("camera", cams, "OBS Virtual Cameraが見つかりません");
  return { mics, cams };
}
async function permissionProbe() {
  let mic = false,
    cam = false;
  const d = await devices();
  try {
    if (d.mics[0]) {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: {
            exact:
              $<HTMLSelectElement>("microphone").value || d.mics[0].deviceId,
          },
        },
        video: false,
      });
      s.getTracks().forEach((x) => x.stop());
      mic = true;
    }
  } catch {}
  try {
    if (d.cams[0]) {
      const s = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: {
            exact: $<HTMLSelectElement>("camera").value || d.cams[0].deviceId,
          },
        },
        audio: false,
      });
      s.getTracks().forEach((x) => x.stop());
      cam = true;
    }
  } catch {}
  await api.mediaPreflight({
    camera: cam,
    audio: mic,
    cameraPermission: cam ? "granted" : "denied",
    microphonePermission: mic ? "granted" : "denied",
    cameraDetail: cam
      ? "OBS Virtual Camera接続済み"
      : "OBS Virtual Cameraまたは権限を確認してください",
    audioDetail: mic ? "マイク接続済み" : "マイク権限を確認してください",
    devices: {
      microphones: d.mics.map((x) => ({
        deviceId: x.deviceId,
        label: x.label,
      })),
      virtualCameras: d.cams.map((x) => ({
        deviceId: x.deviceId,
        label: x.label,
      })),
    },
  });
  return cam && mic;
}
function pcm16(input: Float32Array) {
  const b = new ArrayBuffer(input.length * 2),
    v = new DataView(b);
  for (let i = 0; i < input.length; i++)
    v.setInt16(
      i * 2,
      Math.round(
        Math.max(-1, Math.min(1, input[i])) * (input[i] < 0 ? 32768 : 32767),
      ),
      true,
    );
  return new Uint8Array(b);
}
async function startCamera(ms: number) {
  if (!cameraStream || !recording) return;
  const mime = ["video/webm;codecs=vp8", "video/webm"].find(
    MediaRecorder.isTypeSupported,
  );
  if (!mime) throw new Error("WebM録画が利用できません");
  recorder = new MediaRecorder(cameraStream, {
    mimeType: mime,
    videoBitsPerSecond: 2_500_000,
  });
  cameraStart = Date.now();
  cameraChunkQueue = Promise.resolve();
  recorder.ondataavailable = (e) => {
    if (e.data.size)
      cameraChunkQueue = cameraChunkQueue.then(async () =>
        api.cameraChunk({
          sessionId,
          utcMs: Date.now(),
          monotonicMs: performance.now(),
          bytes: new Uint8Array(await e.data.arrayBuffer()),
        }),
      );
  };
  recorder.start(1000);
  segmentTimer = window.setTimeout(async () => {
    if (recorder?.state === "recording") {
      await stopCamera();
      await api.rotateCamera({
        mimeType: mime,
        plannedBoundaryUtcMs: cameraStart + ms,
      });
      if (recording) await startCamera(ms);
    }
  }, ms);
}
async function stopCamera() {
  clearTimeout(segmentTimer);
  if (recorder && recorder.state !== "inactive")
    await new Promise<void>((r) => {
      recorder!.addEventListener("stop", () => r(), { once: true });
      recorder!.stop();
    });
  await cameraChunkQueue;
  recorder = null;
}
async function setupAudioCapture(stream: MediaStream) {
  audioContext = new AudioContext({ sampleRate: 48000 });
  await audioContext.audioWorklet.addModule(
    new URL("../pcm-worklet.js", location.href),
  );
  const source = audioContext.createMediaStreamSource(stream);
  processor = new AudioWorkletNode(audioContext, "pcm-capture");
  processor.port.onmessage = (e) => {
    if (!recording) return;
    const samples = e.data as Float32Array;
    const level = Math.sqrt(
      samples.reduce((total, value) => total + value * value, 0) /
        samples.length,
    );
    $("level").style.width = `${Math.min(100, level * 500)}%`;
    void api.audioChunk({
      sessionId,
      utcMs: Date.now(),
      monotonicMs: performance.now(),
      bytes: pcm16(samples),
    });
  };
  source.connect(processor);
  processor.connect(audioContext.destination);
}
function scheduleReconnect(kind: "camera" | "audio") {
  if (!recording || reconnectTimers[kind] !== null) return;
  void api.mediaFailed({ channel: kind, reason: "device_disconnected" });
  reconnectTimers[kind] = window.setTimeout(async () => {
    reconnectTimers[kind] = null;
    try {
      if (kind === "camera") {
        await stopCamera();
        cameraStream?.getTracks().forEach((track) => {
          track.onended = null;
          track.stop();
        });
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: activeCameraId! },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
          },
          audio: false,
        });
        cameraStream.getVideoTracks()[0].onended = () =>
          scheduleReconnect("camera");
        $<HTMLVideoElement>("preview").srcObject = cameraStream;
        await $<HTMLVideoElement>("preview").play();
        await startCamera(activeSegmentMs);
      } else {
        processor?.disconnect();
        processor = null;
        if (audioContext) await audioContext.close().catch(() => {});
        audioContext = null;
        audioStream?.getTracks().forEach((track) => {
          track.onended = null;
          track.stop();
        });
        audioStream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: {
            deviceId: { exact: activeMicId! },
            sampleRate: 48000,
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        audioStream.getAudioTracks()[0].onended = () =>
          scheduleReconnect("audio");
        await setupAudioCapture(audioStream);
      }
      await api.mediaRecovered({ channel: kind });
    } catch (error) {
      await api.mediaFailed({ channel: kind, reason: String(error) });
      scheduleReconnect(kind);
    }
  }, 30_000);
}
async function startMedia(s: any) {
  if (recording) return;
  sessionId = s.sessionId;
  const d = await devices(),
    cameraId = s.config.cameraDeviceId || d.cams[0]?.deviceId,
    micId = s.config.microphoneDeviceId || d.mics[0]?.deviceId;
  if (!cameraId || !micId) throw new Error("選択した機器が見つかりません");
  activeCameraId = cameraId;
  activeMicId = micId;
  activeSegmentMs = s.config.segmentMs;
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: { exact: cameraId },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  });
  audioStream = await navigator.mediaDevices.getUserMedia({
    video: false,
    audio: {
      deviceId: { exact: micId },
      sampleRate: 48000,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const video = $<HTMLVideoElement>("preview");
  video.srcObject = cameraStream;
  await video.play();
  recording = true;
  await startCamera(s.config.segmentMs);
  audioContext = new AudioContext({ sampleRate: 48000 });
  await audioContext.audioWorklet.addModule(
    new URL("../pcm-worklet.js", location.href),
  );
  const source = audioContext.createMediaStreamSource(audioStream);
  processor = new AudioWorkletNode(audioContext, "pcm-capture");
  processor.port.onmessage = (e) => {
    if (!recording) return;
    const a = e.data as Float32Array,
      level = Math.sqrt(a.reduce((n, x) => n + x * x, 0) / a.length);
    $("level").style.width = `${Math.min(100, level * 500)}%`;
    api.audioChunk({
      sessionId,
      utcMs: Date.now(),
      monotonicMs: performance.now(),
      bytes: pcm16(a),
    });
  };
  source.connect(processor);
  processor.connect(audioContext.destination);
  const cs = cameraStream.getVideoTracks()[0].getSettings();
  await api.mediaReady({
    camera: {
      label: cameraStream.getVideoTracks()[0].label,
      settings: cs,
      qualityMet:
        (cs.width ?? 0) >= 1280 &&
        (cs.height ?? 0) >= 720 &&
        (cs.frameRate ?? 0) >= 29,
      detail: `${cs.width}×${cs.height} ${cs.frameRate}fps`,
    },
    audio: {
      label: audioStream.getAudioTracks()[0].label,
      settings: audioStream.getAudioTracks()[0].getSettings(),
      qualityMet: audioContext.sampleRate === 48000,
      detail: `${audioContext.sampleRate}Hz mono PCM16`,
    },
  });
  cameraStream.getVideoTracks()[0].onended = () =>
    scheduleReconnect("camera");
  audioStream.getAudioTracks()[0].onended = () => scheduleReconnect("audio");
}
async function stopMedia() {
  recording = false;
  for (const kind of ["camera", "audio"] as const) {
    if (reconnectTimers[kind] !== null) clearTimeout(reconnectTimers[kind]!);
    reconnectTimers[kind] = null;
  }
  await stopCamera();
  processor?.disconnect();
  processor = null;
  if (audioContext) await audioContext.close().catch(() => {});
  audioContext = null;
  cameraStream?.getTracks().forEach((x) => {
    x.onended = null;
    x.stop();
  });
  audioStream?.getTracks().forEach((x) => {
    x.onended = null;
    x.stop();
  });
  cameraStream = audioStream = null;
  $<HTMLVideoElement>("preview").srcObject = null;
}
api.onCommand(async (c: string) => {
  if (c === "probe-media") await permissionProbe();
  if (c === "start-media")
    try {
      await startMedia(await api.getStatus());
    } catch (e) {
      await api.mediaFailed({ channel: "camera", reason: String(e) });
    }
  if (c === "stop-media") await stopMedia();
});
$("permissions").onclick = () => permissionProbe();
$("save").onclick = async () => {
  const m = $<HTMLSelectElement>("microphone"),
    c = $<HTMLSelectElement>("camera");
  await api.saveConfig({
    participantId: $<HTMLInputElement>("participant").value,
    storageRoot: $<HTMLInputElement>("storage").value,
    microphoneDeviceId: m.value || null,
    microphoneLabel: m.selectedOptions[0]?.text,
    cameraDeviceId: c.value || null,
    cameraLabel: c.selectedOptions[0]?.text,
    obsPassword: $<HTMLInputElement>("obsPassword").value,
  });
  $<HTMLInputElement>("obsPassword").value = "";
  await permissionProbe();
};
$("start").onclick = () => api.start();
$("stop").onclick = () => api.stop();
$("quit").onclick = () => api.quit();
$("folder").onclick = () => api.openFolder();
function testResult(id: string, result: any) {
  $(id).textContent = `${result.ok ? "✓" : "✕"} ${result.message}`;
  $(id).className = result.ok ? "ok" : "bad";
  $(`${id}Detail`).textContent = JSON.stringify(result.detail ?? {}, null, 2);
}
async function stopMediaTest() {
  cancelAnimationFrame(testMeterFrame);
  testCameraStream?.getTracks().forEach((track) => track.stop());
  testAudioStream?.getTracks().forEach((track) => track.stop());
  await testAudioContext?.close().catch(() => {});
  testCameraStream = testAudioStream = null;
  testAudioContext = null;
  $<HTMLVideoElement>("testPreview").srcObject = null;
  $<HTMLButtonElement>("stopTest").disabled = true;
}
async function runMediaTest() {
  await stopMediaTest();
  const d = await devices(), cameraId = $<HTMLSelectElement>("camera").value || d.cams[0]?.deviceId, micId = $<HTMLSelectElement>("microphone").value || d.mics[0]?.deviceId;
  try {
    if (!cameraId) throw new Error("OBS Virtual Cameraが見つかりません");
    testCameraStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cameraId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false });
    $<HTMLVideoElement>("testPreview").srcObject = testCameraStream;
    testResult("testCamera", { ok: true, message: "映像を受信中", detail: testCameraStream.getVideoTracks()[0].getSettings() });
  } catch (error) { testResult("testCamera", { ok: false, message: String(error), detail: {} }); }
  try {
    if (!micId) throw new Error("マイクが見つかりません");
    testAudioStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micId }, channelCount: 1, sampleRate: 48000, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    testAudioContext = new AudioContext({ sampleRate: 48000 });
    const source = testAudioContext.createMediaStreamSource(testAudioStream), analyser = testAudioContext.createAnalyser(), values = new Float32Array(analyser.fftSize);
    source.connect(analyser);
    const draw = () => { analyser.getFloatTimeDomainData(values); let sum = 0; for (const value of values) sum += value * value; $("testLevel").style.width = `${Math.min(100, Math.sqrt(sum / values.length) * 500)}%`; testMeterFrame = requestAnimationFrame(draw); };
    draw();
    const settings = testAudioStream.getAudioTracks()[0].getSettings();
    testResult("testMic", { ok: settings.sampleRate === 48000 && settings.channelCount === 1, message: "音声レベルを受信中", detail: { ...settings, audioContextSampleRate: testAudioContext.sampleRate } });
  } catch (error) { testResult("testMic", { ok: false, message: String(error), detail: {} }); }
  $<HTMLButtonElement>("stopTest").disabled = !(testCameraStream || testAudioStream);
}
$<HTMLButtonElement>("runTest").onclick = async () => {
  const button = $<HTMLButtonElement>("runTest");
  button.disabled = true;
  $("testMessage").textContent = "5秒間テスト中…操作してください";
  for (const id of ["testObs", "testAw", "testInput", "testCamera", "testMic"]) { $(id).textContent = "確認中…"; $(id).className = "warn"; }
  await runMediaTest();
  try {
    const result = await api.runDiagnostics();
    testResult("testObs", result.obs); testResult("testAw", result.activitywatch); testResult("testInput", result.input);
    $("testMessage").textContent = `完了: ${new Date(result.checkedAt).toLocaleTimeString()}`;
  } catch (error) { $("testMessage").textContent = String(error); }
  button.disabled = false;
};
$<HTMLButtonElement>("stopTest").onclick = stopMediaTest;
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => button.onclick = async () => {
  const test = button.dataset.page === "test";
  $("recordPage").hidden = test; $("testPage").hidden = !test;
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === button));
  if (!test) await stopMediaTest();
});
void (async () => {
  const s = await api.getStatus();
  $<HTMLInputElement>("participant").value = s.config.participantId;
  $<HTMLInputElement>("storage").value = s.config.storageRoot;
  render(s);
  await devices().catch(() => {});
  setInterval(async () => render(await api.getStatus()), 1000);
})();
