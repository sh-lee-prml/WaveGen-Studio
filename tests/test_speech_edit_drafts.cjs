// Actual production editor + shared controlled DOM/HTTP fixture; no browser/GPU.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture,deferred,flush,wav}=require('./test_speech_edit_recovery.cjs');
const web=path.resolve(__dirname,'../web');
const checks=[];
const check=async(name,fn)=>{await fn();checks.push({name,passed:true});};
const text='Visual review draft: keep this sentence while editing.';
const fire=(f,id,type)=>Promise.all((f.elements.get(id).listeners[type]||[]).map(fn=>fn({target:f.elements.get(id)})));
const mutations=f=>f.calls.filter(call=>['/api/edit','/api/cancel'].includes(call.route));
async function draft(f){
  f.elements.get('edit-text').value=text;await fire(f,'edit-text','input');
  f.edit.select(1.25,3.211625);
  f.elements.get('edit-seed').value='4294967295';await fire(f,'edit-seed','input');
  f.elements.get('edit-model').value='vspec';await fire(f,'edit-model','change');
  f.elements.get('edit-voice').value='d'.repeat(32);await fire(f,'edit-voice','input');
  f.elements.get('edit-match-duration').checked=false;await fire(f,'edit-match-duration','input');
  await f.runTimers(250);
}
async function main(){
  await check('First open and unchanged close never prompt or generate; exact UI text/range/settings survive Escape and reopen',async()=>{
    const f=fixture({count:77079});await f.open();
    assert.equal(f.elements.get('edit-draft-notice').hidden,true);assert.equal(mutations(f).length,0);
    await draft(f);const body=JSON.stringify(f.edit.requestBody());
    await f.edit.getDialog().listeners.cancel[0]({preventDefault(){}});
    assert.equal(f.edit.getState(),null);assert.equal(f.edit.getDialog().open,false);
    await f.open();
    assert.equal(JSON.stringify(f.edit.requestBody()),body);assert.equal(f.edit.getState().start,1.25);
    assert.equal(f.edit.getState().end,77079/24000);assert.equal(f.elements.get('edit-text').value,text);
    assert.equal(f.elements.get('edit-draft-notice').hidden,false);assert.equal(mutations(f).length,0);
    assert.equal(f.results.length,0);assert.equal(f.storage.size,0,'Closed drafts do not become pending native requests');
  });
  await check('Operation mode and its regeneration draft persist independently for each recording and data folder',async()=>{
    const f=fixture();await f.open();await draft(f);
    f.controls.find(button=>button.dataset.editOp==='keep').listeners.click();await f.runTimers(250);f.edit.close();
    const other={...f.item,id:'e'.repeat(32),audio_url:'/api/audio/outputs/'+'e'.repeat(32)};
    await f.edit.open(other);await f.runTimers(250);
    assert.equal(f.edit.getState().operation,'regenerate');assert.equal(f.elements.get('edit-text').value,f.item.text);
    assert.equal(f.elements.get('edit-draft-notice').hidden,true);f.edit.close();await f.open();
    assert.equal(f.edit.getState().operation,'keep');assert.equal(f.elements.get('edit-text').value,text);
    assert.equal(f.elements.get('edit-seed').value,'4294967295');f.edit.close();
    f.status.data_key='another-data-folder';await f.open();
    assert.equal(f.edit.getState().operation,'regenerate');assert.equal(f.elements.get('edit-text').value,f.item.text);
    assert.equal(f.elements.get('edit-draft-notice').hidden,true);
  });
  await check('Reopening a saved result retains its comparison source, Undo/Redo versions and each version’s separate draft',async()=>{
    const f=fixture();await f.open();await draft(f);
    const result={...f.item,id:'c'.repeat(32),audio_url:'/api/audio/outputs/'+'c'.repeat(32),segments:[],transcript_stale:true};
    f.editHandler=async()=>result;await f.edit.apply();await f.runTimers(250);
    assert.equal(f.edit.getState().version,1);assert.equal(f.elements.get('edit-draft-notice').hidden,true);
    f.elements.get('edit-text').value='Draft for the saved version.';await fire(f,'edit-text','input');f.edit.select(.75,2.25);await f.runTimers(250);
    f.edit.close();await f.edit.open(result);await f.runTimers(250);
    assert.equal(f.edit.getState().version,1);assert.equal(f.edit.getState().versions.length,2);
    assert.equal(f.elements.get('edit-original-player').src,f.item.audio_url);assert.equal(f.elements.get('edit-undo').disabled,false);
    assert.equal(f.elements.get('edit-text').value,'Draft for the saved version.');
    await f.edit.stepVersion(-1);await f.runTimers(250);
    assert.equal(f.elements.get('edit-text').value,text);assert.equal(f.edit.getState().start,1.25);
    assert.equal(f.elements.get('edit-seed').value,'4294967295');
    await f.edit.stepVersion(1);await f.runTimers(250);assert.equal(f.edit.getState().start,.75);
    assert.equal(f.elements.get('edit-text').value,'Draft for the saved version.');assert.equal(mutations(f).length,1);
    // A successful later edit must not keep claiming that no new audio was made.
    f.editHandler=async()=>({...result,id:'f'.repeat(32),audio_url:'/api/audio/outputs/'+'f'.repeat(32)});
    await f.edit.apply();assert.equal(f.elements.get('edit-draft-notice').hidden,true);
  });
  await check('Closing during first load cannot let a late response change another recording or create a bogus saved draft',async()=>{
    const f=fixture(),pending=deferred();f.context.fetch=()=>pending.promise;
    const opening=f.edit.open(f.item);f.edit.close();
    const other={...f.item,id:'e'.repeat(32),text:'Other original.',audio_url:'/api/audio/outputs/'+'e'.repeat(32),segments:[]};
    f.context.fetch=async()=>({ok:true,arrayBuffer:async()=>wav(96000)});await f.edit.open(other);await f.runTimers(250);
    pending.resolve({ok:true,arrayBuffer:async()=>wav(77079)});await opening;await flush();
    assert.equal(f.edit.getState().item.id,other.id);assert.equal(f.edit.getState().wave.samples.length,96000);
    f.edit.close();await f.open();assert.equal(f.elements.get('edit-draft-notice').hidden,true);
  });
  await check('Closing an unfinished restored load or Undo load preserves both versions without replacing edits with blank controls',async()=>{
    const f=fixture();await f.open();await draft(f);f.edit.close();
    const pending=deferred();f.context.fetch=()=>pending.promise;const opening=f.edit.open(f.item);f.edit.close();
    pending.resolve({ok:true,arrayBuffer:async()=>wav(96000)});await opening;
    f.context.fetch=async()=>({ok:true,arrayBuffer:async()=>wav(96000)});await f.open();
    assert.equal(f.elements.get('edit-text').value,text);assert.equal(f.edit.getState().start,1.25);
    const result={...f.item,id:'c'.repeat(32),audio_url:'/api/audio/outputs/'+'c'.repeat(32),segments:[]};
    f.editHandler=async()=>result;await f.edit.apply();await f.runTimers(250);
    f.elements.get('edit-text').value='Unsaved result draft.';await fire(f,'edit-text','input');
    const undoPending=deferred();f.context.fetch=()=>undoPending.promise;const undo=f.edit.stepVersion(-1);f.edit.close();
    undoPending.resolve({ok:true,arrayBuffer:async()=>wav(96000)});await undo;
    f.context.fetch=async()=>({ok:true,arrayBuffer:async()=>wav(96000)});await f.edit.open(result);await f.runTimers(250);
    assert.equal(f.elements.get('edit-text').value,'Unsaved result draft.');assert.equal(f.edit.getState().versions.length,2);
    await f.edit.stepVersion(-1);await f.runTimers(250);assert.equal(f.elements.get('edit-text').value,text);
  });
  await check('An invalid numeric draft stays invalid after reopen instead of silently becoming an applicable range',async()=>{
    const f=fixture();await f.open();f.elements.get('edit-start').value='';await fire(f,'edit-start','input');
    f.edit.close();await f.open();assert.equal(Number.isNaN(f.edit.getState().start),true);
    assert.equal(f.elements.get('edit-apply').disabled,true);assert.equal(mutations(f).length,0);
  });
  await check('Restoration notice translates in all four locales without changing user text or creating an output',async()=>{
    const f=fixture();await f.open();await draft(f);f.edit.close();await f.open();
    for(const locale of ['en','ko','zh','ja']){
      f.i18n.setLocale(locale);f.edit.refreshLocale();
      assert.equal(f.elements.get('edit-draft-notice').textContent,f.i18n.t('editUx.draftRestored'));
      assert.notEqual(f.elements.get('edit-draft-notice').textContent,'editUx.draftRestored');
      assert.equal(f.elements.get('edit-text').value,text);
    }
    assert.equal(mutations(f).length,0);
  });
  const files=['speech-edit.js','i18n-ux-edit.js'];
  const report={created_at:new Date().toISOString(),passed:checks.length,failed:0,checks,
    scope:'Actual Speech Edit module with controlled DOM/media/HTTP promises; current-page draft and version restoration, no browser/network/GPU used.',
    sources:Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(web,file))).digest('hex')]))};
  const output=path.join(__dirname,'speech_edit_drafts_validation.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({report:output,passed:checks.length,failed:0}));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
