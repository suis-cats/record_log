import './recorder.css';

declare global { interface Window { researchRecorder: any } }
const api = window.researchRecorder;
void api.rendererReady();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
document.querySelector('#app')!.innerHTML = `<main><header><div><span class="eyebrow">RAW DATA CAPTURE</span><h1>研究レコーダー</h1><p class="muted">分析を行わず、後から検証できる原データだけを保存します。</p></div><div><div class="statusline" id="overall">準備中</div><div class="muted" id="elapsed">00:00:00</div></div></header>
<section class="hero"><div class="preview"><video id="preview" autoplay muted playsinline></video></div><div class="cards" id="cards"></div></section>
<div class="toolbar"><button class="primary" id="start">記録開始</button><button id="stop">停止して保存</button><button id="folder">保存先を開く</button><button class="danger" id="quit">終了</button></div>
<section class="panel"><h2>記録設定</h2><div class="settings"><label>参加者ID<input id="participant"></label><label>マイク<select id="microphone"><option value="">既定のマイク</option></select></label><label class="wide">保存先<input id="storage"></label><label>カメラ<select id="camera"><option value="">OBS Virtual Cameraを自動選択</option></select></label><label>OBS WebSocketパスワード<input id="obsPassword" type="password" placeholder="変更時のみ入力"></label></div><div class="toolbar"><button id="save">設定を保存</button><span class="muted" id="message"></span></div></section>
<section class="panel"><h2>音声レベル</h2><div class="meter"><i id="level"></i></div></section><section class="panel"><h2>記録イベント</h2><div class="events" id="events"></div></section></main>`;

let stream: MediaStream | null = null, recorder: MediaRecorder | null = null, audioContext: AudioContext | null = null, processor: ScriptProcessorNode | null = null;
let mediaStarted = false, mediaStartPromise: Promise<void> | null = null, cameraSegmentStartedAt = 0, cameraFrames = 0, restartTimer: number | null = null, cameraFinalize: Promise<any> = Promise.resolve(), cameraChunkQueue: Promise<any> = Promise.resolve(), drawTimer: number | null = null, encodedVideoTrack: MediaStreamTrack | null = null;
const labels: Record<string,string> = { activitywatch:'ActivityWatch・操作ログ',obs:'OBS録画',camera:'カメラ単独録画',audio:'マイク音声' };
function stateClass(value:string){return value==='recording'||value==='ready'?'ok':value==='failed'||value==='disconnected'?'bad':'warn'}
function render(status:any){
  $('overall').textContent = status.state==='recording'?'記録中':status.state==='waiting'?'準備待ち':status.state==='stopping'?'保存中':'待機';
  $('overall').className=`statusline ${stateClass(status.state)}`;
  const elapsed=status.startedAtMs?Math.max(0,Date.now()-status.startedAtMs):0; const s=Math.floor(elapsed/1000); $('elapsed').textContent=`${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s%3600/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
  $('cards').replaceChildren(...Object.entries(status.channels).map(([key,value]:any)=>{const el=document.createElement('div');el.className='card';el.innerHTML=`<div><span>${labels[key]}</span><strong class="${stateClass(value.state)}">${value.state==='recording'?'保存中':value.state==='ready'?'接続済み':value.state==='waiting'?'待機':value.state==='failed'?'異常':'未接続'}</strong></div><small></small>`;el.querySelector('small')!.textContent=value.detail??'';return el;}));
  $('events').replaceChildren(...status.events.slice(-30).reverse().map((event:any)=>{const el=document.createElement('div');el.textContent=`${new Date(event.at).toLocaleTimeString()}  ${event.type}${event.reason?' · '+event.reason:''}`;return el;}));
  $<HTMLButtonElement>('start').disabled=status.state==='recording'||status.state==='stopping'; $<HTMLButtonElement>('stop').disabled=status.state!=='recording';
  $<HTMLInputElement>('participant').disabled=status.state==='recording'; $<HTMLInputElement>('storage').disabled=status.state==='recording';
  $('message').textContent=status.message??'';
}
async function enumerate(){
  // Asking for a temporary microphone stream can stay pending on Windows and
  // prevents the real camera/audio recorder from ever starting. Electron's
  // permission handler already grants media access to this local page.
  const devices=await navigator.mediaDevices.enumerateDevices();
  const fill=(id:string,kind:MediaDeviceKind,placeholder:string)=>{const select=$<HTMLSelectElement>(id),selected=select.value;select.replaceChildren(new Option(placeholder,''),...devices.filter(x=>x.kind===kind).map(x=>new Option(x.label||kind,x.deviceId)));select.value=selected;};
  fill('microphone','audioinput','既定のマイク'); fill('camera','videoinput','OBS Virtual Cameraを自動選択');
}
async function enumerateWithTimeout(){let timer:number|undefined;try{return await Promise.race([navigator.mediaDevices.enumerateDevices(),new Promise<never>((_,reject)=>{timer=window.setTimeout(()=>reject(new Error('デバイス一覧取得が5秒でタイムアウトしました')),5000)})])}finally{if(timer!==undefined)clearTimeout(timer)}}
function pcm16(input:Float32Array){const out=new Int16Array(input.length);for(let i=0;i<input.length;i++)out[i]=Math.max(-1,Math.min(1,input[i]))*0x7fff;return new Uint8Array(out.buffer)}
async function mediaWithTimeout(constraints:MediaStreamConstraints,label:string){let timer:number|undefined;try{return await Promise.race([navigator.mediaDevices.getUserMedia(constraints),new Promise<never>((_,reject)=>{timer=window.setTimeout(()=>reject(new Error(`${label}の取得が10秒でタイムアウトしました`)),10_000)})])}finally{if(timer!==undefined)clearTimeout(timer)}}
async function stopMedia(){
  mediaStarted=false;if(restartTimer!==null){clearTimeout(restartTimer);restartTimer=null}if(recorder&&recorder.state!=='inactive')await new Promise<void>(resolve=>{recorder!.addEventListener('stop',()=>resolve(),{once:true});recorder!.stop()});await cameraFinalize;recorder=null;
  if(drawTimer!==null){clearInterval(drawTimer);drawTimer=null}encodedVideoTrack?.stop();encodedVideoTrack=null;processor?.disconnect();processor=null;if(audioContext)await audioContext.close().catch(()=>{});audioContext=null;stream?.getTracks().forEach(t=>t.stop());stream=null;$<HTMLVideoElement>('preview').srcObject=null;
}
async function startCameraRecorder(segmentMs:number){
  if(!stream||!mediaStarted||!encodedVideoTrack)return;const mime=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(MediaRecorder.isTypeSupported)??'';
  recorder=new MediaRecorder(new MediaStream([encodedVideoTrack]),mime?{mimeType:mime,videoBitsPerSecond:2_500_000}:undefined);cameraSegmentStartedAt=Date.now();cameraFrames=0;cameraChunkQueue=Promise.resolve();
  recorder.ondataavailable=event=>{if(event.data.size)cameraChunkQueue=cameraChunkQueue.then(async()=>api.cameraChunk(new Uint8Array(await event.data.arrayBuffer())))};
  recorder.onstop=()=>{const details={endedAtMs:Date.now(),startedAtMs:cameraSegmentStartedAt,mimeType:recorder?.mimeType,frameCount:cameraFrames};cameraFinalize=cameraChunkQueue.then(()=>api.rotateCamera(details)).then(()=>{if(mediaStarted)return startCameraRecorder(segmentMs)})};
  recorder.onerror=event=>void api.mediaFailed({channel:'camera',reason:String((event as any).error??'MediaRecorder error')}); recorder.start(1000); restartTimer=window.setTimeout(()=>{restartTimer=null;if(recorder?.state==='recording')recorder.stop()},segmentMs);
}
async function startMedia(config:any){
  void api.mediaStage('start');await stopMedia();void api.mediaStage('enumerating');const devices=await enumerateWithTimeout();void api.mediaStage(`devices:${devices.length}`);const virtual=devices.find(d=>d.kind==='videoinput'&&/obs.*virtual camera/i.test(d.label));const cameraId=config.cameraDeviceId||virtual?.deviceId;
  if(!cameraId)throw new Error('OBS Virtual Cameraが見つかりません');
  const videoStream=await mediaWithTimeout({video:{deviceId:{exact:cameraId},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}},audio:false},'OBS Virtual Camera');
  let audioStream:MediaStream;
  try{audioStream=await mediaWithTimeout({video:false,audio:{deviceId:config.microphoneDeviceId?{exact:config.microphoneDeviceId}:undefined,sampleRate:48000,channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false}},'マイク')}catch(error){videoStream.getTracks().forEach(track=>track.stop());throw error}
  stream=new MediaStream([...videoStream.getVideoTracks(),...audioStream.getAudioTracks()]);
  mediaStarted=true;const video=$<HTMLVideoElement>('preview');video.srcObject=new MediaStream(stream.getVideoTracks());void video.play().catch(error=>api.mediaFailed({channel:'camera',reason:`プレビュー再生失敗: ${error}`}));const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const context=canvas.getContext('2d')!;drawTimer=window.setInterval(()=>{if(video.readyState>=2){context.drawImage(video,0,0,1280,720);if(recorder?.state==='recording')cameraFrames++}},1000/30);encodedVideoTrack=canvas.captureStream(30).getVideoTracks()[0];
  const vt=stream.getVideoTracks()[0],at=stream.getAudioTracks()[0],details={camera:{label:vt.label,settings:vt.getSettings()},audio:{label:at.label,settings:at.getSettings()}};await api.mediaReady(details);
  for(const track of stream.getTracks())track.onended=()=>{void api.mediaFailed({channel:track.kind==='video'?'camera':'audio',reason:'device_disconnected'});void stopMedia()};
  audioContext=new AudioContext({sampleRate:48000});const source=audioContext.createMediaStreamSource(new MediaStream([at]));processor=audioContext.createScriptProcessor(4096,1,1);processor.onaudioprocess=event=>{if(!mediaStarted)return;const samples=event.inputBuffer.getChannelData(0),level=Math.sqrt(samples.reduce((n,x)=>n+x*x,0)/samples.length);$('level').style.width=`${Math.min(100,level*500)}%`;void api.audioChunk(pcm16(samples));};source.connect(processor);processor.connect(audioContext.destination);
  await startCameraRecorder(config.segmentMs);
}
async function sync(){void startMedia;void mediaStartPromise;const status=await api.getStatus();render(status);if(mediaStarted)await stopMedia();}
api.onCommand((command:string)=>{if(command==='start-media'){void api.rendererReady();void sync()}if(command==='stop-media')void stopMedia().then(()=>api.mediaReady({stopped:true}))});
$('save').onclick=async()=>{const microphone=$<HTMLSelectElement>('microphone'),camera=$<HTMLSelectElement>('camera'),devices=await enumerateWithTimeout(),defaultMicrophone=devices.find(d=>d.kind==='audioinput'&&d.deviceId==='default')??devices.find(d=>d.kind==='audioinput'),virtualCamera=devices.find(d=>d.kind==='videoinput'&&/obs.*virtual camera/i.test(d.label));await api.saveConfig({participantId:$<HTMLInputElement>('participant').value,storageRoot:$<HTMLInputElement>('storage').value,microphoneDeviceId:microphone.value||null,microphoneLabel:microphone.value?microphone.selectedOptions[0]?.text:defaultMicrophone?.label,cameraDeviceId:camera.value||null,cameraLabel:camera.value?camera.selectedOptions[0]?.text:virtualCamera?.label||'OBS Virtual Camera',obsPassword:$<HTMLInputElement>('obsPassword').value});$<HTMLInputElement>('obsPassword').value='';await sync()};
$('start').onclick=()=>void api.start().then(sync);$('stop').onclick=()=>void api.stop().then(sync);$('quit').onclick=()=>void api.quit();$('folder').onclick=()=>void api.openFolder();
void (async()=>{const status=await api.getStatus();$<HTMLInputElement>('participant').value=status.config.participantId;$<HTMLInputElement>('storage').value=status.config.storageRoot;render(status);await sync();void enumerate().then(()=>{$<HTMLSelectElement>('microphone').value=status.config.microphoneDeviceId??'';$<HTMLSelectElement>('camera').value=status.config.cameraDeviceId??''}).catch(()=>{});setInterval(()=>void sync(),1000)})();
