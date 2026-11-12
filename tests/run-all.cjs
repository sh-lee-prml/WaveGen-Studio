'use strict';
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const names=['frontend_ux','i18n','frontend_trim','reference_core','speech_edit_core','speech_edit_races','speech_edit_models','voice_workflow','history_workflow','speech_edit_recovery','speech_edit_drafts','result_workspace','personal_voice_ui'];
for(const name of names){
  const result=spawnSync(process.execPath,[path.join(__dirname,`test_${name}.cjs`)],{stdio:'inherit'});
  if(result.status!==0)process.exit(result.status||1);
}
console.log(`Passed ${names.length} frontend suites. No browser, network, model or GPU was used.`);
