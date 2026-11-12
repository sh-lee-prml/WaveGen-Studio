// Catalog completeness and locale policy checks against the shipped JS sources.
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const webRoot=path.resolve(__dirname,'../web');
const html=fs.readFileSync(path.join(webRoot,'index.html'),'utf8');
const scripts=Array.from(html.matchAll(/<script\b[^>]*src="\/(i18n(?:-[\w-]+)?\.js)"/g),match=>match[1]);
assert.deepEqual(scripts.slice(0,3),['i18n.js','i18n-zh.js','i18n-ja.js']);
assert.equal(new Set(scripts).size,scripts.length,'Each catalog must be registered once');
const checks=[];
function makeContext(stored,blocked=false) {
  const values=new Map(stored==null?[]:[['wavegen.uiLocale.v1',stored]]);
  const events=[];
  const context={
    localStorage:{getItem:key=>{if(blocked)throw new Error('Storage blocked');return values.get(key)??null;},setItem:(key,value)=>{if(blocked)throw new Error('Storage blocked');values.set(key,String(value));}},
    navigator:{language:'ko-KR'},document:{documentElement:{lang:'ko'}},
    CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},
    dispatchEvent:event=>events.push(event)
  };
  context.window=context;
  vm.createContext(context);
  for(const file of scripts)vm.runInContext(fs.readFileSync(path.join(webRoot,file),'utf8'),context,{filename:file});
  return {context,values,events,i18n:context.StudioI18n};
}
function mark(name,extra={}){checks.push({name,passed:true,...extra});}
const initial=makeContext();
assert.equal(initial.i18n.getLocale(),'en');
assert.equal(initial.i18n.t('app.language'),'Display language');
mark('First run defaults to English even when the browser language is Korean');
const keys=Array.from(initial.i18n.getKeys()).sort();
assert(keys.length>100);
const placeholders=text=>Array.from(text.matchAll(/\{(\w+)\}/g),match=>match[1]).sort();
const en=initial.i18n.getCatalog('en');
for(const locale of ['en','ko','zh','ja']){
  const catalog=initial.i18n.getCatalog(locale);
  assert.deepEqual(Object.keys(catalog).sort(),keys,locale+' has missing/extra translation keys');
  for(const key of keys){
    assert.equal(typeof catalog[key],'string',locale+':'+key);
    assert(catalog[key].trim().length>0,locale+':'+key+' empty');
    assert.deepEqual(placeholders(catalog[key]),placeholders(en[key]),locale+':'+key+' changed placeholders');
    assert(!catalog[key].includes('\uFFFD'),locale+':'+key+' replacement character');
  }
  const sample=makeContext(locale);
  assert.equal(sample.i18n.getLocale(),locale);
  assert(sample.i18n.setLocale(locale));
  assert.equal(sample.context.document.documentElement.lang,locale==='zh'?'zh-CN':locale);
  assert.equal(sample.values.get('wavegen.uiLocale.v1'),locale);
  assert.equal(sample.events.at(-1).detail.locale,locale);
  const userName='User Voice 한국어 中文 日本語 <original>';
  assert(sample.i18n.t('voice.referenceLabel',{name:userName}).includes(userName));
  for(const key of keys){
    const variables=Object.fromEntries(placeholders(catalog[key]).map(name=>[name,'123']));
    assert(!/\{\w+\}/.test(sample.i18n.t(key,variables)),locale+':'+key+' unresolved variable');
  }
  mark('Complete '+locale+' catalog, matching variables, persistence, lang attribute and user-text preservation',{keys:keys.length});
}
const malformed=makeContext('not-a-language');
assert.equal(malformed.i18n.getLocale(),'en');
assert.equal(malformed.i18n.setLocale('xx'),false);
assert.equal(malformed.i18n.getLocale(),'en');
mark('Unsupported saved locales and requests fall back safely');
const blocked=makeContext(null,true);
assert.equal(blocked.i18n.getLocale(),'en');
assert.equal(blocked.i18n.setLocale('ja'),true);
assert.equal(blocked.i18n.getLocale(),'ja');
mark('Locale switching works when browser storage is unavailable');
const alternating=makeContext();
for(const locale of ['ja','ko','zh','en']){
  alternating.i18n.setLocale(locale);
  assert.equal(alternating.i18n.t('app.language'),initial.i18n.getCatalog(locale)['app.language']);
}
assert.equal(alternating.i18n.getLocale(),'en');
mark('Repeated locale switches return to the explicit English default');
const relocalizing=makeContext();
const voiceName='Saved voice 한국어 中文 日本語';
const originalLabel=relocalizing.i18n.t('voice.referenceLabel',{name:voiceName});
let translatedLabel=originalLabel;
let translatedError=relocalizing.i18n.t('error.audioSilent');
for(const locale of ['ko','ja','zh','en']){
  relocalizing.i18n.setLocale(locale);
  translatedLabel=relocalizing.i18n.translate(translatedLabel);
  translatedError=relocalizing.i18n.translate(translatedError);
  assert.equal(translatedLabel,relocalizing.i18n.t('voice.referenceLabel',{name:voiceName}));
  assert.equal(translatedError,relocalizing.i18n.t('error.audioSilent'));
}
assert.equal(translatedLabel,originalLabel);
assert.equal(relocalizing.i18n.translate('Unmatched user text 日本語'),'Unmatched user text 日本語');
relocalizing.i18n.setLocale('zh');
assert.equal(relocalizing.i18n.translate('Invalid stored voice profile fields'),'Invalid stored voice profile fields');
assert.equal(relocalizing.i18n.translate('12.4s'),relocalizing.i18n.t('common.durationSeconds',{seconds:'12.4'}));
mark('Visible messages relocalize repeatedly while interpolated user names remain intact');
const app=fs.readFileSync(path.join(webRoot,'app.js'),'utf8');
const editor=fs.readFileSync(path.join(webRoot,'speech-edit.js'),'utf8');
const referenceEditor=html.includes('src="/reference-editor.js"')?fs.readFileSync(path.join(webRoot,'reference-editor.js'),'utf8'):'';
assert(/<html\b[^>]*lang="en"/.test(html));
const order=[...scripts,'app.js'].map(file=>html.indexOf('src="/'+file+'"'));
assert(order.every((position,index)=>position>=0&&(index===0||position>order[index-1])));
for(const id of ['generation-text','reference-text']){
  const tag=html.match(new RegExp('<textarea\\b[^>]*id="'+id+'"[^>]*>'))?.[0];
  assert(tag&&/lang="en"/.test(tag),id+' must keep its TTS input language');
}
assert(html.includes('id="ui-language"'));
mark('English initial HTML, ordered offline catalogs, and unchanged English speech input fields');
const literalKeys=new Set([...html.matchAll(/data-i18n(?:-[\w-]+)?="([a-zA-Z][\w.]+)"/g)].map(match=>match[1]));
for(const match of app.matchAll(/\bt\(\s*["']([a-zA-Z][\w.]+)["']\s*[,)]/g))literalKeys.add(match[1]);
for(const match of editor.matchAll(/\b(?:t|mark)\(\s*["']([a-zA-Z][\w.]+)["']\s*[,)]/g))literalKeys.add(match[1]);
for(const match of referenceEditor.matchAll(/\b(?:t|mark|translate)\(\s*["']([a-zA-Z][\w.]+)["']\s*[,)]/g))literalKeys.add(match[1]);
for(const match of referenceEditor.matchAll(/data-reference-label="([a-zA-Z][\w.]+)"/g))literalKeys.add(match[1]);
for(const key of literalKeys)assert(keys.includes(key),'Unknown literal locale key: '+key);
mark('All literal HTML and application translation references resolve',{referenced_keys:literalKeys.size});
const report={created_at:new Date().toISOString(),passed:checks.length,failed:0,keys_per_locale:keys.length,
  scope:'Actual local dictionaries, variable interpolation and locale policy. Browser UI behavior is verified separately.',
  sources:Object.fromEntries([...scripts,'app.js','index.html','style.css',...(referenceEditor?['reference-editor.js']:[])].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(webRoot,file))).digest('hex')])),checks};
fs.writeFileSync(path.join(__dirname,'i18n_validation.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,failed:0,keys_per_locale:keys.length}));
