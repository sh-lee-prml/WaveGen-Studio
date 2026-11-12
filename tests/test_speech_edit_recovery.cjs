// Actual editor module with controlled HTTP promises, reload storage, media and timers.
// No real browser, HTTP request, GPU or audio device is used.
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const web=path.resolve(__dirname,'../web');
const source=fs.readFileSync(path.join(web,'speech-edit.js'),'utf8');
const catalogs=['i18n.js','i18n-zh.js','i18n-ja.js','i18n-features.js','i18n-models.js','i18n-ux-edit.js'];
const pendingKey='wavegen.speechEdit.pending.v1';
const watchdog=require.main===module?setTimeout(()=>{console.error('Speech Edit recovery tests did not settle within 15 seconds');process.exit(1);},15000):null;
const sourceId='a'.repeat(32),voiceId='b'.repeat(32),resultId='c'.repeat(32);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function wav(count){const b=Buffer.alloc(44+count*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(count*2,40);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);}
function fixture({storage=new Map(),count=96000,initialStatus}={}){
  const elements=new Map(),timers=new Map(),calls=[],busyChanges=[],results=[],toasts=[];
  let timerId=0,busy=false;
  const controls=['regenerate','cut','keep'].map(operation=>({dataset:{editOp:operation},listeners:{},setAttribute(){},addEventListener(type,fn){this.listeners[type]=fn;}}));
  class Element{
    constructor(id=''){this.id=id;this.value='';this.checked=false;this.hidden=false;this.disabled=false;this.open=false;this.dataset={};this.style={};this.listeners={};this.attributes={};this.textContent='';this.clientWidth=600;this.classList={toggle(){}};}
    set innerHTML(value){this.html=value;for(const m of value.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)){const e=new Element(m[1]);e.hidden=/\shidden(?:\s|>)/.test(m[0]);elements.set(m[1],e);}}
    get innerHTML(){return this.html||'';} addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
    setAttribute(key,value){this.attributes[key]=value;} getAttribute(key){return this.attributes[key];} removeAttribute(key){delete this.attributes[key];}
    querySelectorAll(selector){return selector==='[data-edit-op]'?controls:[];} showModal(){this.open=true;} close(){this.open=false;}
    pause(){} load(){} append(){} setPointerCapture(){} focus(){}
    getContext(){return{scale(){},clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){}};}
    getBoundingClientRect(){return{left:0,width:600};}
  }
  const item={id:sourceId,voice_id:voiceId,voice_name:'Reference',model_id:'flash',seed:7,text:'Original complete phrase.',duration_seconds:count/24000,audio_url:'/api/audio/outputs/'+sourceId,segments:[{text:'Original complete phrase.',start_seconds:0,end_seconds:count/24000}]};
  const f={elements,timers,calls,busyChanges,results,toasts,storage,item,controls,
    status:initialStatus||{state:'ready',request_id:'',data_key:'isolated-data',can_cancel:false},history:[item],
    editHandler:async()=>{throw new Error('Edit fixture not configured');},cancelHandler:async()=>({cancelled:true}),statusHandler:null,historyHandler:null};
  const context={window:{dispatchEvent(){}},document:{documentElement:{lang:'en'},body:new Element(),createElement:()=>new Element(),getElementById:id=>elements.get(id)},
    CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},localStorage:{getItem:()=>null,setItem(){}},
    sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},
    fetch:async()=>({ok:true,arrayBuffer:async()=>wav(count)}),crypto:crypto.webcrypto,DataView,ArrayBuffer,Uint8Array,Uint32Array,Float32Array,Map,Promise,Math,Number,Error,TypeError,
    setTimeout(fn,delay){timers.set(++timerId,{fn,delay});return timerId;},clearTimeout:id=>timers.delete(id),setInterval(){return 1;},clearInterval(){}};
  vm.createContext(context);
  for(const file of catalogs)vm.runInContext(fs.readFileSync(path.join(web,file),'utf8'),context,{filename:file});
  const boundary='window.StudioSpeechEdit={init,open,refreshLocale,refreshModels};';
  assert(source.includes(boundary));
  vm.runInContext(source.replace(boundary,boundary+'globalThis.__edit={open,close,apply,cancelJob,inputRange,select,requestBody,schedulePlan,refreshModels,refreshLocale,stepVersion,loadItem,recoverPendingEdit,restorePendingEdit,getState:()=>state,getDialog:()=>dialog};'),context,{filename:'speech-edit.js'});
  const hooks={t:context.window.StudioI18n.t,escapeHtml:value=>String(value??''),safeAudioUrl:value=>value,formatDuration:value=>value+'s',readableError:error=>error.message,
    modelId:value=>value==null?'flash':String(value),modelIssue:()=>'',renderModelControl(id,hint,model,disabled){elements.get(id).value=model;elements.get(id).disabled=disabled;},
    getVoices:()=>[{id:voiceId,name:'Reference'}],getStatus:()=>({...f.status,state:busy?'generating':f.status.state}),
    showToast:message=>toasts.push(message),onBusyChange:value=>{busy=value;busyChanges.push(value);},onResult:async value=>results.push(value),
    api:async(route,options={})=>{calls.push({route,options});if(route==='/api/edit/plan')return{duration_seconds:count/24000,selection_duration_seconds:options.json.end_seconds-options.json.start_seconds,replacement_duration_seconds:1};
      if(route==='/api/edit')return f.editHandler(options.json);
      if(route==='/api/status')return f.statusHandler?f.statusHandler():f.status;
      if(route.startsWith('/api/history?')){assert.match(route,/^\/api\/history\?limit=60&q=[a-f0-9]{32}$/);return f.historyHandler?f.historyHandler():{items:f.history};}
      if(route==='/api/cancel')return f.cancelHandler(options.json);
      throw new Error('Unexpected route '+route);}};
  context.window.StudioSpeechEdit.init(hooks);
  Object.assign(f,{context,hooks,edit:context.__edit,i18n:context.window.StudioI18n});
  f.runTimers=async(delay)=>{const tasks=[...timers.entries()].filter(([,v])=>delay===undefined||v.delay===delay);for(const[id,task]of tasks){timers.delete(id);await task.fn();}await flush();};
  f.open=async()=>{await f.edit.open(item);await f.runTimers(250);};
  f.startDisconnected=async()=>{await f.open();f.editHandler=async body=>{f.status={...f.status,state:'generating',request_id:body.request_id,can_cancel:true};throw new TypeError('Network disconnected');};await f.edit.apply();return f.edit.getState().requestId;};
  f.complete=id=>{const result={...item,id:resultId,request_id:id,audio_url:'/api/audio/outputs/'+resultId};f.history=[result,item];f.status={...f.status,state:'ready',request_id:'',can_cancel:false};return result;};
  return f;
}
const checks=[];const mark=name=>checks.push({name,passed:true});
async function main(){
  const precision=fixture({count:77079});await precision.open();
  assert.equal(Number(precision.elements.get('edit-end').value),3.211625);
  precision.elements.get('edit-end').value='3.212';precision.elements.get('edit-start').value='1.5';
  precision.edit.inputRange({target:precision.elements.get('edit-start')});
  assert.equal(precision.edit.getState().end,77079/24000);assert.equal(precision.edit.requestBody().end_seconds,77079/24000);
  assert.equal(precision.context.window.StudioSpeechEditCore.sampleRange(1.5,precision.edit.getState().end,77079).last,77079);
  mark('Editing one numeric endpoint preserves the other canonical 77,079-sample boundary without importing rounded display text');

  const active=fixture(),requestId=await active.startDisconnected();
  assert.match(requestId,/^[a-f0-9]{32}$/);assert.equal(active.edit.getState().busy,true);assert.equal(active.edit.getState().recovering,true);
  assert.equal(JSON.parse(active.storage.get(pendingKey)).requestId,requestId);
  assert.equal(active.elements.get('edit-cancel-job').hidden,false);assert.equal(active.elements.get('edit-cancel-job').disabled,false);
  active.edit.close();assert(active.edit.getState(),'Closing cannot abandon the active request');
  assert.equal(active.calls.filter(c=>c.route==='/api/edit').length,1);
  assert(active.calls.filter(c=>c.route==='/api/status').every(c=>c.options.timeout===7000));
  assert(active.calls.filter(c=>c.route.startsWith('/api/history?')).every(c=>c.options.timeout===10000&&c.route.endsWith(requestId)));
  mark('Network loss preserves a busy cancellable request, persists its ID, and performs bounded native status plus exact-ID history queries without resubmitting');

  const earlyResult=active.complete(requestId);active.status={...active.status,state:'generating',request_id:requestId,can_cancel:true};
  await active.edit.recoverPendingEdit();assert.equal(active.results.length,0);assert.equal(active.edit.getState().busy,true);
  while(active.edit.getState().recoveryChecks<5)await active.runTimers(1000);
  assert.equal(active.edit.getState().recoveryChecks,5);assert.equal([...active.timers.values()].filter(t=>t.delay===1000).length,0);
  assert.equal(active.edit.getState().requestId,requestId);assert(active.storage.has(pendingKey));
  active.status={...active.status,state:'ready',request_id:'',can_cancel:false};
  assert.equal(active.hooks.getStatus().state,'generating','The parent masks own pending work as busy');
  active.edit.refreshModels();await active.runTimers(0);
  assert.equal(active.edit.getState().busy,false);assert.equal(active.edit.getState().requestId,null);assert.equal(active.storage.has(pendingKey),false);
  assert.equal(active.results.at(-1).id,earlyResult.id);
  mark('Early history metadata does not finish an active job; five automatic checks retain recovery, and native completion releases the self-masked busy state');

  const cancelled=fixture(),cancelId=await cancelled.startDisconnected();
  let cancelledId;cancelled.cancelHandler=async body=>{cancelledId=body.request_id;return{cancelled:true};};
  await cancelled.edit.cancelJob();assert.equal(cancelledId,cancelId);assert.equal(JSON.parse(cancelled.storage.get(pendingKey)).cancelled,true);
  cancelled.status={...cancelled.status,state:'ready',request_id:'',can_cancel:false};
  await cancelled.edit.recoverPendingEdit();assert.equal(cancelled.edit.getState().busy,true);
  await cancelled.edit.recoverPendingEdit();assert.equal(cancelled.edit.getState().busy,false);assert.equal(cancelled.storage.has(pendingKey),false);
  assert.equal(cancelled.edit.getState().item.id,sourceId);assert.equal(cancelled.calls.filter(c=>c.route==='/api/edit').length,1);
  assert(cancelled.toasts.includes(cancelled.i18n.t('edit.cancelled')));
  mark('Accepted cancellation targets the original request and clears recovery only after stable idle confirmation, preserving the original recording');

  const uncertain=fixture(),uncertainId=await uncertain.startDisconnected();
  uncertain.status={...uncertain.status,state:'ready',request_id:'',can_cancel:false};
  for(let i=0;i<5;i++)await uncertain.edit.recoverPendingEdit();
  assert.equal(uncertain.edit.getState().busy,true);assert.equal(uncertain.edit.getState().requestId,uncertainId);
  assert.equal(uncertain.storage.has(pendingKey),true);assert.equal(uncertain.elements.get('edit-stop-waiting').hidden,false);
  assert.equal(uncertain.elements.get('edit-stop-waiting-hint').hidden,false);
  uncertain.status={...uncertain.status,state:'generating',request_id:uncertainId,can_cancel:true};
  await uncertain.edit.recoverPendingEdit();assert.equal(uncertain.elements.get('edit-stop-waiting').hidden,true);
  assert.equal(uncertain.edit.getState().busy,true,'A late native reservation must still be tracked');
  uncertain.status={...uncertain.status,state:'ready',request_id:'',can_cancel:false};
  await uncertain.edit.recoverPendingEdit();await uncertain.edit.recoverPendingEdit();
  for(const locale of ['en','ko','zh','ja']){uncertain.i18n.setLocale(locale);assert.notEqual(uncertain.i18n.t('editUx.stopWaitingHint'),'editUx.stopWaitingHint');assert.notEqual(uncertain.i18n.t('editUx.stopWaiting'),'editUx.stopWaiting');}
  const callsBeforeDismiss=uncertain.calls.length;
  await uncertain.elements.get('edit-stop-waiting').listeners.click[0]();
  assert.equal(uncertain.edit.getState(),null);assert.equal(uncertain.storage.has(pendingKey),false);
  assert.equal(uncertain.busyChanges.at(-1),false);assert.equal(uncertain.calls.length,callsBeforeDismiss);
  assert.equal(uncertain.calls.filter(c=>c.route==='/api/edit').length,1);assert.equal(uncertain.calls.filter(c=>c.route==='/api/cancel').length,0);
  assert.equal(uncertain.toasts.length,0,'Stopping local tracking must not claim cancellation or completion');
  mark('Repeated idle observations never abandon an unconfirmed POST, late reservations remain tracked, and explicit Stop waiting only closes local tracking without resubmit or cancellation claims');

  const first=fixture();await first.open();first.elements.get('edit-text').value='Keep this replacement draft.';first.elements.get('edit-seed').value='87';
  first.edit.schedulePlan();await first.runTimers(250);
  first.editHandler=async body=>{first.status={...first.status,state:'generating',request_id:body.request_id,can_cancel:true};throw new TypeError('Lost response');};
  await first.edit.apply();const reloadId=first.edit.getState().requestId;
  const reloaded=fixture({storage:first.storage,initialStatus:{...first.status}});await reloaded.runTimers(0);
  assert.equal(reloaded.edit.getState().requestId,reloadId);assert.equal(reloaded.edit.getState().recovering,true);
  assert.equal(reloaded.elements.get('edit-text').value,'Keep this replacement draft.');assert.equal(Number(reloaded.elements.get('edit-seed').value),87);
  assert.equal(reloaded.calls.filter(c=>c.route==='/api/edit').length,0,'Reload must never resubmit a GPU edit');
  let reloadedCancel;reloaded.cancelHandler=async body=>{reloadedCancel=body.request_id;return{cancelled:true};};await reloaded.edit.cancelJob();assert.equal(reloadedCancel,reloadId);
  const saved=reloaded.complete(reloadId);await reloaded.edit.recoverPendingEdit();assert.equal(reloaded.results.at(-1).id,saved.id);
  assert.equal(reloaded.storage.has(pendingKey),false);assert.equal(reloaded.edit.getState().busy,false);
  mark('Reload restores source, captured text, seed and request identity; it can cancel or recover the saved edit without another generation');

  const offline=fixture(),offlineId=await offline.startDisconnected();offline.statusHandler=()=>{throw new TypeError('Still offline');};
  for(let i=0;i<5;i++)await offline.edit.recoverPendingEdit();
  assert.equal(offline.edit.getState().requestId,offlineId);assert.equal(offline.edit.getState().busy,true);
  assert.equal(offline.elements.get('edit-recovery').hidden,false);assert.equal(offline.elements.get('edit-recovery-check').disabled,false);
  assert.equal(offline.elements.get('edit-cancel-job').hidden,false);
  const capturedText=offline.elements.get('edit-text').value;
  for(const locale of ['en','ko','zh','ja']){offline.i18n.setLocale(locale);offline.context.window.StudioSpeechEdit.refreshLocale();assert.equal(offline.elements.get('edit-recovery-status').textContent,offline.i18n.t('editUx.uncertain'));assert.equal(offline.elements.get('edit-text').value,capturedText);assert.equal(offline.edit.getState().requestId,offlineId);}
  mark('Exhausted or failed checks keep a clear four-language recovery notice, manual retry, cancellation and the captured editor draft');

  const mismatch=fixture(),mismatchId=await mismatch.startDisconnected();mismatch.status={...mismatch.status,data_key:'another-data',state:'ready',request_id:''};
  await mismatch.edit.recoverPendingEdit();assert.equal(mismatch.edit.getState().busy,false);assert.equal(mismatch.storage.has(pendingKey),false);
  assert.equal(mismatch.calls.filter(c=>c.route==='/api/cancel').length,0);assert.equal(mismatch.results.length,0);
  assert.equal(mismatch.elements.get('edit-error').textContent,mismatch.i18n.t('editUx.otherData'));
  mark('Recovery against a different data folder does not cancel or attach the old request to the new server data');

  const failed=fixture();await failed.open();const before=JSON.stringify(failed.item);
  failed.editHandler=async()=>{throw Object.assign(new Error('Rejected edit'),{status:400});};await failed.edit.apply();
  assert.equal(failed.edit.getState().busy,false);assert.equal(failed.storage.has(pendingKey),false);assert.equal(JSON.stringify(failed.item),before);
  assert.equal(failed.calls.filter(c=>c.route.startsWith('/api/history?')).length,0);
  mark('A definitive HTTP rejection releases the pending lock immediately and leaves the immutable source unchanged');

  assert.equal(checks.length,9,'Every asynchronous regression group must finish before a passing report is written');
  const report={created_at:new Date().toISOString(),node_version:process.version,passed:checks.length,failed:0,checks,
    scope:'Actual Speech Edit module with mocked DOM/media, controlled native-shaped HTTP responses, timers and sessionStorage reloads. No browser, network, GPU, model or audio device used.',
    sources:Object.fromEntries(['speech-edit.js','speech-edit.css',...catalogs].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(web,file))).digest('hex')]))};
  const output=path.join(__dirname,'speech_edit_recovery_validation.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({report:output,passed:checks.length,failed:0}));
}
module.exports={fixture,deferred,flush,wav};
if(require.main===module)main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
