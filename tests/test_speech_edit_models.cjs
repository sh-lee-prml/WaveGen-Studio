// Actual editor state, requests, version history and model loading locks; no server/GPU.
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const web=path.resolve(__dirname,'../web');
const source=fs.readFileSync(path.join(web,'speech-edit.js'),'utf8');
const elements=new Map(), timers=new Map(), requests=[], applied=[], controls=[];
let timerId=0,nextResult=null,globalStatus={state:'ready'},deferPlan=false,resolvePlan;
const available=new Set(['flash','vspec']);
const operationButtons=['regenerate','cut','keep'].map(operation=>({dataset:{editOp:operation},listeners:{},setAttribute(){},addEventListener(type,handler){this.listeners[type]=handler;}}));
class Element {
  constructor(id=''){this.id=id;this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.open=false;this.dataset={};this.style={};this.listeners={};this.attributes={};this.textContent='';this.clientWidth=600;this.classList={toggle(){}};}
  set innerHTML(value){this._html=value;for(const match of value.matchAll(/id="([^"]+)"/g))elements.set(match[1],new Element(match[1]));}
  get innerHTML(){return this._html||'';}
  addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
  setAttribute(key,value){this.attributes[key]=value;}
  removeAttribute(key){delete this.attributes[key];}
  getAttribute(key){return this.attributes[key];}
  querySelectorAll(selector){return selector==='[data-edit-op]'?operationButtons:[];}
  showModal(){this.open=true;}
  close(){this.open=false;}
  pause(){} load(){} append(){} focus(){} setPointerCapture(){}
  getContext(){return {scale(){},clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){}};}
  getBoundingClientRect(){return {left:0,width:600};}
}
function wav(){const b=Buffer.alloc(44+96000*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(192000,40);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);}
const buffer=wav();
const context={window:{dispatchEvent(){}},document:{documentElement:{lang:'en'},body:new Element(),createElement:()=>new Element(),getElementById:id=>elements.get(id)},
  CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},
  localStorage:{getItem:()=>null,setItem(){}},
  fetch:async()=>({ok:true,status:200,arrayBuffer:async()=>buffer}),
  crypto:crypto.webcrypto,DataView,ArrayBuffer,Uint8Array,Uint32Array,Float32Array,Math,Number,Map,Promise,Error,
  setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout(id){timers.delete(id);},setInterval(){return 1;},clearInterval(){}
};
vm.createContext(context);
for(const name of ['i18n.js','i18n-zh.js','i18n-ja.js','i18n-features.js','i18n-library.js','i18n-models.js','i18n-ux-edit.js'])vm.runInContext(fs.readFileSync(path.join(web,name),'utf8'),context);
const instrumented=source.replace('window.StudioSpeechEdit={init,open,refreshLocale,refreshModels};','window.StudioSpeechEdit={init,open,refreshLocale,refreshModels}; globalThis.__edit={open,close,loadItem,requestBody,schedulePlan,apply,stepVersion,select,refreshModels,getState:()=>state};');
assert.notEqual(instrumented,source);vm.runInContext(instrumented,context);
const i18n=context.window.StudioI18n, t=i18n.t, editor=context.__edit;
let composerDraft={text:'Independent composer draft.',model_id:'flash',seed:71};
const hooks={t,escapeHtml:value=>String(value??''),safeAudioUrl:value=>value,formatDuration:value=>value+'s',readableError:error=>error.message,showToast(){},
  modelId:value=>value==null?'flash':String(value),
  modelIssue:id=>!['flash','vspec'].includes(id)?t('models.unknown',{model:id}):!available.has(id)?t('models.unavailable',{model:id==='vspec'?'V-Spec':'Flash'}):'',
  renderModelControl(selectId,hintId,id,disabled){const select=elements.get(selectId);select.value=id;select.disabled=disabled;controls.push({selectId,id,disabled});},
  getVoices:()=>[{id:'voice',name:'Saved voice'}],getStatus:()=>globalStatus,onBusyChange(){},
  onResult:async item=>applied.push(item.id),
  api:async(route,options)=>{requests.push({route,body:JSON.parse(JSON.stringify(options.json))});
    if(route==='/api/edit/plan'){if(deferPlan)return new Promise(resolve=>{resolvePlan=resolve;});return {duration_seconds:4,selection_duration_seconds:options.json.end_seconds-options.json.start_seconds,replacement_duration_seconds:1};}
    if(route==='/api/edit')return nextResult;throw new Error(route);}
};
context.window.StudioSpeechEdit.init(hooks);
const fire=(id,type)=>{for(const fn of elements.get(id).listeners[type]||[])fn({target:elements.get(id)});};
const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
async function runPlan(){const pending=[...timers.values()];timers.clear();for(const fn of pending)await fn();await flush();}
const checks=[];const mark=name=>checks.push({name,passed:true});
function item(id,model_id){return {id,model_id,text:'Original source passage.',voice_id:'voice',voice_name:'Saved voice',seed:7,duration_seconds:4,audio_url:'/api/audio/outputs/'+id,segments:[{text:'Original source passage.',start_seconds:0,end_seconds:4}]};}
async function main(){
  const original=item('original','vspec'),unchangedComposer=JSON.stringify(composerDraft);
  await editor.open(original);await runPlan();
  assert.equal(editor.getState().modelId,'vspec');assert.equal(elements.get('edit-model').value,'vspec');
  assert.equal(requests.at(-1).body.model_id,'vspec');assert.equal(requests.at(-1).body.source_id,'original');
  assert.equal(JSON.stringify(composerDraft),unchangedComposer);
  mark('Opening a V-Spec history item initializes its own regeneration mode and plan without changing the composer');

  elements.get('edit-text').value='A replacement draft.';elements.get('edit-seed').value='23';
  elements.get('edit-model').value='flash';fire('edit-model','change');await runPlan();
  assert.equal(editor.requestBody().model_id,'flash');assert.equal(editor.requestBody().text,'A replacement draft.');assert.equal(editor.requestBody().seed,23);
  nextResult={...item('replacement','flash'),segments:[],transcript_stale:true,model_scope:'replacement'};
  await editor.apply();await runPlan();
  const editRequest=requests.find(request=>request.route==='/api/edit');assert.equal(editRequest.body.model_id,'flash');assert.equal(editRequest.body.text,'A replacement draft.');
  assert.equal(editor.getState().item.id,'replacement');assert.equal(editor.getState().modelId,'flash');
  await editor.stepVersion(-1);await runPlan();
  assert.equal(editor.getState().item.id,'original');assert.equal(editor.getState().modelId,'flash');
  assert.equal(elements.get('edit-text').value,'A replacement draft.');assert.equal(elements.get('edit-seed').value,'23');
  assert.equal(JSON.stringify(composerDraft),unchangedComposer);
  mark('Changing regeneration mode preserves typed text/seed, sends it explicitly, and undo restores the per-version selection');

  editor.close();await editor.open(item('legacy',undefined));await runPlan();
  assert.equal(editor.getState().modelId,'flash');assert.equal(editor.requestBody().model_id,'flash');
  elements.get('edit-model').value='vspec';fire('edit-model','change');await runPlan();editor.close();
  await editor.open(item('another-legacy',undefined));await runPlan();assert.equal(editor.getState().modelId,'flash');
  mark('Closing and opening another recording cannot leak the previous editor mode; legacy history defaults to Flash');

  globalStatus={state:'loading_model',active_model_id:'vspec'};editor.refreshModels();
  assert.equal(elements.get('edit-model').disabled,true);
  elements.get('edit-model').value='vspec';fire('edit-model','change');assert.equal(editor.getState().modelId,'flash');assert.equal(elements.get('edit-model').value,'flash');
  const beforeBusy=requests.length;await editor.apply();assert.equal(requests.length,beforeBusy);
  globalStatus={state:'ready'};editor.refreshModels();assert.equal(elements.get('edit-model').disabled,false);
  mark('Lazy loading in another request locks the editor selector and blocks edits without silently changing its selected mode');

  editor.close();await editor.open(item('unknown','future-model'));await runPlan();
  assert.equal(editor.getState().modelId,'future-model');assert(elements.get('edit-error').textContent.includes('future-model'));
  const beforeUnknown=requests.length;await editor.apply();assert.equal(requests.length,beforeUnknown);
  operationButtons.find(button=>button.dataset.editOp==='cut').listeners.click();editor.select(1,2);await runPlan();
  const cut=requests.at(-1);assert.equal(cut.route,'/api/edit/plan');assert.equal(cut.body.operation,'cut');assert.equal(Object.hasOwn(cut.body,'model_id'),false);
  mark('Unknown regeneration modes fail visibly while model-free Cut still works and sends no replacement model');

  editor.close();available.delete('vspec');await editor.open(item('unavailable','vspec'));await runPlan();
  assert.equal(elements.get('edit-apply').disabled,true);assert(elements.get('edit-error').textContent.includes('V-Spec'));
  elements.get('edit-model').value='flash';fire('edit-model','change');await runPlan();assert.equal(requests.at(-1).body.model_id,'flash');
  assert.equal(editor.getState().modelId,'flash');available.add('vspec');
  mark('Unavailable V-Spec remains selected with a clear error until the user explicitly chooses Flash');

  deferPlan=true;elements.get('edit-model').value='vspec';fire('edit-model','change');
  const task=[...timers.values()][0];timers.clear();const oldPlan=task();await flush();
  elements.get('edit-model').value='flash';fire('edit-model','change');
  resolvePlan({duration_seconds:4,selection_duration_seconds:4,replacement_duration_seconds:4});await oldPlan;
  assert.equal(editor.getState().plan,null);assert.equal(elements.get('edit-apply').disabled,true);
  deferPlan=false;await runPlan();assert.equal(JSON.parse(editor.getState().plan.key).model_id,'flash');
  mark('A late V-Spec plan cannot validate a newer Flash choice or re-enable the stale request');

  for(const locale of ['ko','zh','ja','en']){i18n.setLocale(locale);context.window.StudioSpeechEdit.refreshLocale();assert.equal(editor.getState().modelId,'flash');assert.equal(JSON.stringify(composerDraft),unchangedComposer);}
  mark('Locale refresh preserves the editor model and independent composer draft');
  const report={created_at:new Date().toISOString(),node:process.version,passed:checks.length,failed:0,checks,
    source:path.join(web,'speech-edit.js'),source_sha256:crypto.createHash('sha256').update(source).digest('hex'),
    scope:'Actual editor JS with mocked DOM/media, controlled requests, and native-shaped WAV data. No server, browser, GPU, or model loaded.'};
  fs.writeFileSync(path.join(__dirname,'speech_edit_models_validation.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:checks.length,failed:0}));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
