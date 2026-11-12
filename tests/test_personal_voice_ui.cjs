// node tests/test_personal_voice_ui.cjs
// Production app without the retired candidate gallery; no browser/GPU.
'use strict';
const fs=require('node:fs'),path=require('node:path');
const setup=fs.readFileSync(path.join(__dirname,'test_frontend_ux.cjs'),'utf8').split('async function main() {')[0];
const tests=String.raw`
(async()=>{
  await flush();const t=sandbox.__test,tr=sandbox.window.StudioI18n.t;
  assert(!/character-library|character-dialog|i18n-characters|selected-character-note|voice-character-note/.test(html));
  assert(!productionSource.includes('StudioCharacters'));assert.equal(sandbox.window.StudioCharacters,undefined);
  assert(html.includes('id="current-output"'));assert(html.includes('id="show-output"'));
  passed('The candidate gallery, entry, dialog, assets and shortlist bridge are absent; the immediate output workspace remains');
  const five=[voice,...['b','c','d','e'].map((letter,index)=>({...voice,id:letter.repeat(32),name:['Nature','Mira','Rowan','Kai'][index]}))];
  t.state.voices=five;t.state.voicesLoading=false;t.state.status={state:'ready',enhancement:{available:true,loaded:true}};t.state.connected=true;
  storage.set('wavegen.characterShortlist.v1',JSON.stringify(['f'.repeat(32)]));
  t.applyDraft({text:'Keep my current story.',voice_id:five[3].id,model_id:'vspec',seed:42,speed:1.1,split_long_text:false,duration_mode:'auto',enhance_output:true});
  const saved=JSON.stringify(t.currentDraft());
  for(const locale of ['en','ko','zh','ja']){
    sandbox.window.StudioI18n.setLocale(locale);t.renderVoices();
    assert.equal(elements.get('voice-count').textContent,5);assert.equal(t.state.selectedId,five[3].id);assert.equal(JSON.stringify(t.currentDraft()),saved);
    for(const item of five)assert(elements.get('voice-list').innerHTML.includes(item.name));
    for(const key of ['voiceOwn.add','voiceOwn.shortGuide','voiceOwn.guide','voiceOwn.permission'])assert(tr(key)&&tr(key)!==key);
  }
  assert.equal(JSON.parse(storage.get('wavegen.characterShortlist.v1'))[0],'f'.repeat(32));
  passed('Five existing voices and selected voice/text/model/settings survive all locales; obsolete shortlist data has no effect');
  elements.get('voice-add').click();assert(t.state.modal);assert.equal(t.state.modal.voice,null);assert.equal(JSON.stringify(t.currentDraft()),saved);assert.equal(elements.get('voice-name').value,'');assert.equal(elements.get('reference-text').value,'');t.closeVoiceEditor(true);
  elements.get('voice-add-icon').click();assert(t.state.modal);assert.equal(t.state.modal.voice,null);t.closeVoiceEditor(true);
  passed('Both visible Add voice actions open a blank editor without disturbing the current generation draft');
  const samples=new Float32Array(3*24000);for(let i=0;i<samples.length;i++)samples[i]=.15*Math.sin(2*Math.PI*240*i/24000);
  audioDecodeHandler=async()=>decodedAudio(samples);elements.get('voice-add').click();elements.get('voice-name').value='My own voice';elements.get('reference-text').value='This is my own recording.';
  await t.chooseAudio(new File([new Uint8Array([1])],'my-recording.wav'));const before=voiceWrites.length;
  await t.saveVoice({preventDefault(){}});assert.equal(voiceWrites.length,before);assert.equal(t.state.modal.transcriptRequired,true);
  elements.get('reference-confirmed').checked=true;for(const handler of elements.get('reference-confirmed').listeners.change||[])handler();
  await t.saveVoice({preventDefault(){}});const form=voiceWrites.at(-1);assert.equal(form.get('name'),'My own voice');assert.equal(form.get('reference_text'),'This is my own recording.');assert(form.has('audio'));assert(form.has('original_audio'));assert(!form.has('character_effect'));
  passed('Personal registration retains real audio preparation and transcript confirmation, saving the prepared and original recording without character effects');
  t.state.voices=five;t.state.status={state:'ready',enhancement:{available:true,loaded:true}};t.state.generating=false;t.state.recovering=false;
  const unchangedHistory=[];
  for(const [index,metadata] of [
    {character_effect:{id:'basalt',version:1},character_effect_scope:'full'},
    {character_effect:{id:'tin',version:1},character_effect_scope:'replacement'},
    {character_effect:{id:'pixel',version:1},character_effect_scope:'inherited'},
    {source_character_effect:{id:'basalt',version:1},derived_from_character:true,character_effect_may_be_softened:true}
  ].entries()){
    const item={id:'historical-'+index,voice_id:'f'.repeat(32),voice_name:'Original saved voice name',text:'The original saved sentence.',audio_url:'/api/audio/outputs/historical-'+index,created_at:'2026-11-12T00:00:00Z',duration_seconds:4,...metadata};
    const original=JSON.stringify(item);unchangedHistory.push(item);t.state.history=unchangedHistory.slice();t.state.activeResultId=item.id;t.renderResults();
    for(const locale of ['en','ko','zh','ja']){
      sandbox.window.StudioI18n.setLocale(locale);const keys=['output.characterFull','output.characterReplacement','output.characterInherited','output.characterMixed'];
      assert(elements.get('result-settings').textContent.includes(tr(keys[index])));if(index===3)assert(elements.get('result-settings').textContent.includes(tr('output.characterSoftened')));
      assert.equal(elements.get('result-voice-name').textContent,item.voice_name);assert.equal(JSON.stringify(item),original);
    }
  }
  passed('Existing historical full/replacement/inherited/mixed effect labels remain localized without loading a candidate library or changing old metadata');
  const requestsBefore=generatedRequests.length;t.reuseResult(unchangedHistory[0]);assert.equal(t.currentDraft().voice_id,'');assert.equal(t.currentDraft().text,unchangedHistory[0].text);assert.equal(t.state.requireVoiceSelection,true);assert.equal(generatedRequests.length,requestsBefore);
  passed('Reusing a recording whose old candidate was removed requires a new voice selection instead of silently substituting a basic voice');
  const css=fs.readFileSync(path.join(webRoot,'style.css'),'utf8');assert(/\.voice-panel \.new-voice-button\{display:flex/.test(css));assert(/@media\(max-width:660px\)\{\.own-voice-guidance[\s\S]*?\.voice-panel \.new-voice-button\{display:flex/.test(css));
  for(const key of ['voiceOwn.shortGuide','voiceOwn.guide','voiceOwn.permission'])assert(html.includes('data-i18n="'+key+'"'));
  for(const locale of ['en','ko','zh','ja']){sandbox.window.StudioI18n.setLocale(locale);assert(tr('voiceOwn.guide').includes('30'));}
  passed('Desktop/mobile Add voice stays visible and guidance covers clear audio, matching words, under-30-second final length and permission in four languages');
  const files=['app.js','index.html','style.css','i18n-ux-history.js','i18n-ux-voice.js'];const report={created_at:new Date().toISOString(),passed:checks.length,failed:0,checks,browser_used:false,gpu_used:false,scope:'Actual frontend executed with deterministic DOM/API/audio mocks. Real user-data removal and rendered layout are validated separately.',sources:Object.fromEntries(files.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(webRoot,name))).digest('hex')]))};
  const target=path.join(__dirname,'personal_voice_ui_validation.json');fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({report:target,passed:checks.length,failed:0}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
`;
new Function('require','__dirname',setup+tests)(require,__dirname);
