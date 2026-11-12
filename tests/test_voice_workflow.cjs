// Reproduce: node tests/test_voice_workflow.cjs
// Reuses only the existing deterministic DOM/API harness setup, not its tests.
// Executes the current production app and reference editor; no browser or GPU.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const harnessPath = path.join(__dirname, 'test_frontend_ux.cjs');
const harness = fs.readFileSync(harnessPath, 'utf8');
const boundary = harness.indexOf('async function main() {');
if (boundary < 0) throw new Error('Shared test harness setup boundary changed');
const setup = harness.slice(0, boundary);
const tests = String.raw`
(async () => {
  await flush();
  const t = sandbox.__test, editor = sandbox.window.StudioReferenceEditor;
  const text = sandbox.window.StudioI18n.t;
  const submit = () => t.saveVoice({ preventDefault() {} });
  const ready = () => { status = { ...status, state:'ready', request_id:'', can_cancel:false, cancel_requested:false, enhancement:{ available:true, loaded:true } }; t.state.status=status; };
  const confirm = () => { elements.get('reference-confirmed').checked=true; for (const handler of elements.get('reference-confirmed').listeners.change || []) handler(); };
  const close = () => t.closeVoiceEditor(true);
  const samples = new Float32Array(6*24000);
  for(let i=24000;i<5*24000;i++)samples[i]=.15*Math.sin(2*Math.PI*220*i/24000);
  const originalHash=crypto.createHash('sha256').update(Buffer.from(samples.buffer)).digest('hex');
  audioDecodeHandler=async()=>decodedAudio(samples); ready();
  const enhancedVoice={...voice, original_audio_url:'/api/audio/voices/'+voice.id+'/original', reference_edit_version:1, selection_start_seconds:1, selection_end_seconds:4, trim_enabled:false, normalize_enabled:false, normalization_gain_db:0, duration_seconds:3, prompt_enhancement:{enabled:true,id:'saved-enhancement'}};

  t.openVoiceEditor(enhancedVoice); await t.loadReferenceEditor();
  assert.equal(t.state.modal.audioDirty,false); assert.equal(t.voiceEditorDirty(),false);
  editor.changeSettings({startSeconds:1.25}); assert.equal(t.state.modal.audioDirty,true);
  elements.get('reference-undo').click();
  assert.equal(t.state.modal.audioDirty,false); assert.equal(t.state.modal.file,null); assert.equal(t.state.modal.trim,null);
  assert.equal(new URL(elements.get('reference-player').src).pathname,enhancedVoice.audio_url);
  assert.equal(elements.get('reference-enhancement-badge').hidden,false);
  assert.equal(t.state.modal.transcriptRequired,false); assert.equal(t.voiceEditorDirty(),false);
  passed('Undo to saved baseline restores exact saved enhanced URL, clean dirty state and original provenance');
  elements.get('reference-redo').click(); assert.equal(t.state.modal.audioDirty,true);
  elements.get('reference-undo').click(); elements.get('voice-name').value='Only a renamed voice';
  await submit();
  for(const key of ['audio','original_audio','prompt_enhancement_id','reference_edit_version','trim_enabled','normalize_enabled'])assert.equal(voiceWrites.at(-1).has(key),false);
  assert.equal(voiceWrites.at(-1).get('name'),'Only a renamed voice');
  passed('Redo remains available; save after Undo sends metadata only and preserves saved enhancement');

  t.openVoiceEditor(enhancedVoice);await t.loadReferenceEditor();
  const avatarBlob=new File(['prepared-avatar'],'character.png',{type:'image/png'});
  t.state.modal.avatarFile=avatarBlob;t.state.modal.avatarDirty=true;elements.get('voice-name').value='Name with avatar';
  editor.changeSettings({normalizeEnabled:true});elements.get('reference-undo').click();
  assert.equal(t.state.modal.avatarFile,avatarBlob);assert.equal(t.state.modal.avatarDirty,true);
  assert.equal(elements.get('voice-name').value,'Name with avatar');await submit();
  assert.equal(voiceWrites.at(-1).has('avatar'),true);assert.equal(voiceWrites.at(-1).has('audio'),false);
  passed('Restoring audio baseline preserves unrelated name and avatar edits');

  t.openVoiceEditor(enhancedVoice);elements.get('voice-name').value='Keep this rename';elements.get('reference-text').value='Keep these revised words.';
  audioDecodeHandler=async()=>{throw new Error('Controlled decoder failure');};
  await t.chooseAudio(new File([new Uint8Array([1])],'broken.wav'));
  assert(t.state.modal.audioError);assert.equal(elements.get('voice-save').disabled,true);assert.equal(elements.get('voice-audio-recover').hidden,false);
  elements.get('voice-audio-recover').click();
  assert.equal(t.state.modal.audioError,'');assert.equal(t.state.modal.audioDirty,false);assert.equal(t.state.modal.audioRecovery,null);
  assert.equal(elements.get('voice-name').value,'Keep this rename');assert.equal(elements.get('reference-text').value,'Keep these revised words.');
  assert.equal(new URL(elements.get('reference-player').src).pathname,enhancedVoice.audio_url);await submit();
  assert.equal(voiceWrites.at(-1).has('audio'),false);
  passed('Failed audio replacement can keep the saved recording without losing text or name changes');

  audioDecodeHandler=async()=>decodedAudio(samples);t.openVoiceEditor();
  elements.get('voice-name').value='New sample';elements.get('reference-text').value='My newly uploaded words.';
  await t.chooseAudio(new File([new Uint8Array([2])],'working.wav'));confirm();
  const previousFile=t.state.modal.file,previousOriginal=t.state.modal.original,previousSettings=JSON.stringify(t.state.modal.referenceSettings);
  audioDecodeHandler=async()=>{throw new Error('Controlled second decode failure');};
  await t.chooseAudio(new File([new Uint8Array([3])],'failed-replacement.wav'));
  elements.get('voice-audio-recover').click();
  assert.equal(t.state.modal.file,previousFile);assert.equal(t.state.modal.original,previousOriginal);assert.equal(JSON.stringify(t.state.modal.referenceSettings),previousSettings);
  assert.equal(t.state.modal.transcriptConfirmed,true);assert.equal(t.state.modal.filename,'working.wav');
  assert.equal(t.state.modal.newSource,true);assert.equal(elements.get('reference-player').src,t.state.modal.previewUrl);
  await submit();assert.equal(voiceWrites.at(-1).has('audio'),true);assert.equal(voiceWrites.at(-1).has('original_audio'),true);
  passed('Failed replacement recovery also preserves an unsaved uploaded source, exact prepared file and transcript confirmation');

  t.openVoiceEditor(enhancedVoice);let attempts=0;
  audioDecodeHandler=async()=>{attempts++;if(attempts===1)throw new Error('Transient decode failure');return decodedAudio(samples);};
  const sameFile=new File([new Uint8Array([4])],'same-file.wav'),input=elements.get('voice-audio');
  for(let attempt=0;attempt<2;attempt++){input.value='C:/fakepath/same-file.wav';input.files=[sameFile];for(const handler of input.listeners.change)handler();assert.equal(input.value,'');await flush();}
  assert.equal(attempts,2);assert.equal(t.state.modal.audioError,'');assert.equal(t.state.modal.filename,'same-file.wav');close();
  passed('Choosing the same file retries because the file input is reset after each selection');

  t.openVoiceEditor(enhancedVoice);elements.get('voice-name').value='Rename despite unavailable original';
  audioDecodeHandler=async()=>{throw new Error('Cannot decode saved original');};await t.loadReferenceEditor();
  assert(t.state.modal.audioError);elements.get('voice-audio-recover').click();await submit();
  assert.equal(voiceWrites.at(-1).has('audio'),false);assert.equal(voiceWrites.at(-1).get('name'),'Rename despite unavailable original');
  passed('Failure to open the saved original does not trap metadata-only edits');

  function unload(){let prevented=false;const event={preventDefault(){prevented=true;}};windowListeners.get('beforeunload')(event);return {prevented,event};}
  assert.equal(unload().prevented,false);t.openVoiceEditor(enhancedVoice);assert.equal(unload().prevented,false);
  elements.get('voice-name').value='Unsaved name';assert.equal(unload().prevented,true);assert.equal(unload().event.returnValue,'');
  close();assert.equal(unload().prevented,false);
  passed('Refresh/tab-close warning applies only to a dirty voice editor and clears after closing');

  audioDecodeHandler=async()=>decodedAudio(samples);ready();
  async function preview(id){const pending=t.enhanceReference();await flush();const form=referenceEnhancementRequests.at(-1);enhancementWave=await form.get('audio').arrayBuffer();new DataView(enhancementWave).setInt16(100,777,true);const count=new DataView(enhancementWave).getUint32(40,true)/2;ready();referenceEnhancementResolve({id,audio_url:'/api/audio/enhancement/'+id+'.wav',input_audio_url:'/api/audio/enhancement/'+id+'-before.wav',samples:count,sample_rate:24000});await pending;}
  t.openVoiceEditor(enhancedVoice);await t.loadReferenceEditor();await preview('choose-before-save');
  const writes=voiceWrites.length;await submit();assert.equal(voiceWrites.length,writes);
  assert.equal(elements.get('voice-enhancement-options').open,true);assert.equal(document.activeElement,elements.get('reference-enhance-apply'));
  assert.equal(elements.get('voice-save-status').textContent,text('uxVoice.chooseEnhancement'));
  t.discardReferenceEnhancement();await submit();assert.equal(voiceWrites.at(-1).has('audio'),false);
  passed('Saving an unresolved enhancement comparison requires an explicit version choice; keeping original preserves saved audio');

  t.openVoiceEditor(enhancedVoice);await t.loadReferenceEditor();await preview('apply-exact-bytes');t.applyReferenceEnhancement();
  const priorWrites=voiceWrites.length;await submit();assert.equal(voiceWrites.length,priorWrites);confirm();
  const expected=Buffer.from(enhancementWave);failVoiceSave=true;await submit();
  assert(t.state.modal.promptEnhancementApplied);assert.equal(t.state.modal.enhancementPreview.id,'apply-exact-bytes');
  await submit();assert.equal(voiceWrites.at(-1).get('prompt_enhancement_id'),'apply-exact-bytes');
  assert.deepEqual(Buffer.from(await voiceWrites.at(-1).get('audio').arrayBuffer()),expected);assert.equal(voiceWrites.at(-1).has('original_audio'),false);
  passed('Applied enhancement requires transcript confirmation and retains exact token-bound WAV through a save failure and retry');

  t.openVoiceEditor(enhancedVoice);await t.loadReferenceEditor();await preview('recover-applied-preview');t.applyReferenceEnhancement();confirm();
  const applied=t.state.modal.enhancementPreview,appliedFile=applied.file;
  audioDecodeHandler=async()=>{throw new Error('Controlled failed replacement after enhancement');};
  await t.chooseAudio(new File([new Uint8Array([5])],'bad-after-enhancement.wav'));
  elements.get('reference-text').value='Changed words while replacing the recording.';
  elements.get('voice-audio-recover').click();
  assert.equal(t.state.modal.enhancementPreview,applied);assert.equal(t.state.modal.enhancementPreview.file,appliedFile);
  assert.equal(t.state.modal.promptEnhancementApplied,true);assert.equal(t.state.modal.audioDirty,true);
  assert.equal(elements.get('reference-player').src,applied.audioUrl);assert.equal(elements.get('reference-before-player').src,applied.beforeUrl);assert.equal(elements.get('reference-after-player').src,applied.audioUrl);
  assert.equal(t.state.modal.transcriptConfirmed,false);assert.equal(elements.get('reference-confirmed').checked,false);
  assert.equal(elements.get('audio-duration').textContent,t.formatDuration ? t.formatDuration(3) : sandbox.window.StudioI18n.t('common.durationSeconds',{seconds:'3.0'}));
  const beforeRecoverySave=voiceWrites.length;await submit();assert.equal(voiceWrites.length,beforeRecoverySave);confirm();await submit();
  assert.equal(voiceWrites.at(-1).get('prompt_enhancement_id'),'recover-applied-preview');assert.deepEqual(Buffer.from(await voiceWrites.at(-1).get('audio').arrayBuffer()),Buffer.from(await appliedFile.arrayBuffer()));
  passed('Failed replacement after applied enhancement restores comparison URLs and exact enhanced file without reviving stale transcript confirmation');

  assert(html.indexOf('id="audio-dropzone"')<html.indexOf('id="reference-text"'));
  assert(html.indexOf('id="reference-text"')<html.indexOf('id="voice-enhancement-options"'));
  assert(html.indexOf('id="reference-text"')<html.indexOf('id="voice-avatar-options"'));
  for(const id of ['voice-avatar-options','voice-enhancement-options','voice-source'])assert(new RegExp('<details[^>]*id="'+id+'"[^>]*>').test(html));
  const css=fs.readFileSync(path.join(webRoot,'style.css'),'utf8');assert(/\.voice-dialog \.dialog-actions\{[^}]*position:sticky;[^}]*bottom:-28px/.test(css));
  assert(/id="voice-save"[^>]*aria-describedby="voice-save-status voice-error"/.test(html));
  for(const id of ['reference-before-player','reference-after-player'])assert(new RegExp('id="'+id+'"[^>]*data-i18n-aria-label="enhance\.(before|after)"').test(html));
  passed('Static structure keeps audio/transcript first, optional sections collapsed, labelled comparison audio and a sticky described save footer');
  t.openVoiceEditor(enhancedVoice);for(const locale of ['en','ko','zh','ja']){sandbox.window.StudioI18n.setLocale(locale);assert.equal(elements.get('voice-save-status').textContent,sandbox.window.StudioI18n.t('uxVoice.saveUnchanged'));assert.equal(t.state.modal.audioDirty,false);}close();
  assert.equal(crypto.createHash('sha256').update(Buffer.from(samples.buffer)).digest('hex'),originalHash);assert.equal(activeObjectUrls.size,0);
  passed('Four-language status changes preserve audio state; source buffers remain immutable and temporary URLs are released');
  const names=['app.js','index.html','style.css','reference-editor.js','i18n-ux-voice.js'];
  const report={created_at:new Date().toISOString(),passed:checks.length,failed:0,checks,browser_used:false,gpu_used:false,scope:'Actual production frontend executed using deterministic DOM/API/decoded-audio mocks. Layout checks inspect source CSS/structure, not rendered pixels.',sources:Object.fromEntries(names.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(webRoot,name))).digest('hex')])),harness_sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'test_frontend_ux.cjs'))).digest('hex')};
  const destination=path.join(__dirname,'voice_workflow_validation.json');fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({report:destination,passed:checks.length,failed:0}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
`;
new Function('require','__dirname',setup+tests)(require,__dirname);
