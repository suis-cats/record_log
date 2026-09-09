import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export function participantId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error('Use an anonymous ID: 1-64 letters, digits, _ or -');
  return value;
}
export function safeInput(value) {
  if (!['keydown','click','scroll','movement','heartbeat','gap'].includes(value.type)) throw new Error('Invalid input event');
  const result = { type: value.type };
  for (const key of ['timestamp_ms','monotonic_ms','interval_ms','delta_x','delta_y','scroll_x','scroll_y']) {
    if (value[key] === null) result[key] = null;
    else if (Number.isFinite(value[key])) result[key] = value[key];
  }
  if (!Number.isFinite(result.timestamp_ms)) throw new Error('Input timestamp required');
  return result;
}
export class RawStudy {
  constructor(dir, identity) { this.dir=join(dir,'raw'); this.identity=Object.freeze({...identity}); this.queue=Promise.resolve(); this.versions=new Map(); this.lastSavedAt=null; this.error=null; this.inputSeen=false; }
  append(file, event) {
    const row={...event,...this.identity,acquired_at_ms:Date.now()};
    if (Number.isFinite(row.timestamp_ms)) row.iso_utc=new Date(row.timestamp_ms).toISOString();
    this.queue=this.queue.then(async()=>{await mkdir(this.dir,{recursive:true});await appendFile(join(this.dir,file),JSON.stringify(row)+'\n');this.lastSavedAt=Date.now();}).catch(error=>{this.error=String(error);});
    return this.queue;
  }
  input(value) { const event=safeInput(value); if(['keydown','click','scroll'].includes(event.type)) this.inputSeen=true; return this.append('input_events.jsonl',{...event,source:'windows_input_hook'}); }
  activity(bucketId, events) {
    for(const event of events){const key=`${bucketId}:${event.id}`,version=JSON.stringify(event);if(this.versions.get(key)===version)continue;this.versions.set(key,version);this.append('activitywatch_events.jsonl',{source:'activitywatch',bucket_id:bucketId,event,timestamp_ms:Date.parse(event.timestamp)});}
    return this.queue;
  }
  async exportCsv() {
    await this.queue;
    const read=async name=>(await readFile(join(this.dir,name),'utf8').catch(()=>'' )).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const inputs=await read('input_events.jsonl'),controls=await read('control_events.jsonl'),versions=await read('activitywatch_events.jsonl');
    const latest=new Map();for(const row of versions)latest.set(`${row.bucket_id}:${row.event.id}`,row);
    const windows=[...latest.values()].filter(x=>x.event.data?.app).sort((a,b)=>a.timestamp_ms-b.timestamp_ms);
    const csv=async(name,rows,columns)=>{const keys=['participant_id','session_id',...columns];const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';await writeFile(join(this.dir,name),keys.join(',')+'\r\n'+rows.map(row=>keys.map(k=>quote(row[k]??this.identity[k])).join(',')).join('\r\n'));};
    await csv('events.csv',[...inputs,...controls].sort((a,b)=>a.timestamp_ms-b.timestamp_ms),['timestamp_ms','iso_utc','acquired_at_ms','source','type','monotonic_ms','interval_ms','delta_x','delta_y','scroll_x','scroll_y']);
    await csv('applications.csv',windows.map(x=>({...x,start_ms:x.timestamp_ms,end_ms:x.timestamp_ms+x.event.duration*1000,application:x.event.data.app,title:x.event.data.title})),['start_ms','end_ms','application','title']);
    await csv('app_switches.csv',windows.flatMap((x,i)=>i&&windows[i-1].event.data.app!==x.event.data.app?[{timestamp_ms:x.timestamp_ms,from_app:windows[i-1].event.data.app,to_app:x.event.data.app}]:[]),['timestamp_ms','from_app','to_app']);
    await csv('automatic_conversations.csv',controls.filter(x=>x.type==='automatic_conversation'),['conversation_id','timestamp_ms','end_ms','duration_ms','detector']);
    const groups=new Map();for(const x of inputs){if(!['keydown','click','scroll','movement'].includes(x.type))continue;const t=Math.floor(x.timestamp_ms/1000)*1000;const g=groups.get(t)??{timestamp_ms:t,keystrokes:0,clicks:0,scroll_x:0,scroll_y:0,delta_x:0,delta_y:0,intervals:[]};if(x.type==='keydown'){g.keystrokes++;if(Number.isFinite(x.interval_ms))g.intervals.push(x.interval_ms);}if(x.type==='click')g.clicks++;for(const k of ['scroll_x','scroll_y','delta_x','delta_y'])g[k]+=x[k]??0;groups.set(t,g);}
    await csv('input_summary.csv',[...groups.values()].map(g=>({...g,mean_interval_ms:g.intervals.length?g.intervals.reduce((a,b)=>a+b,0)/g.intervals.length:null})),['timestamp_ms','keystrokes','mean_interval_ms','clicks','scroll_x','scroll_y','delta_x','delta_y']);
  }
}
