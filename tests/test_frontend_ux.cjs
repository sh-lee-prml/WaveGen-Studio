// Reproduce with: node tests/test_frontend_ux.cjs
// Executes actual frontend source against a deterministic DOM/API harness.
// No live server, browser, audio hardware, or GPU is used.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const webRoot = path.resolve(__dirname, '../web');
const html = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8');
const productionSource = fs.readFileSync(path.join(webRoot, 'app.js'), 'utf8');
const catalogNames = Array.from(html.matchAll(/<script\b[^>]*src="\/(i18n(?:-[\w-]+)?\.js)"/g), match => match[1]);
const elements = new Map();
const timers = new Map();
const documentListeners = new Map();
const avatarDraws = [], revokedUrls = [], voiceWrites = [];
const activeObjectUrls = new Set();
let avatarDecodeHandler = null, bitmapCloses = 0, nextObjectUrl = 0, failVoiceSave = false;
let audioDecodeHandler = null, audioReads = 0;
let enhancementResolve = null, referenceEnhancementResolve = null;
const enhancementRequests = [], referenceEnhancementRequests = [];
let enhancementWave = null;
let nextTimer = 0;

class Element {
  constructor(id = '') {
    this.id = id; this.value = ''; this.checked = false; this.hidden = false;
    this.disabled = false; this.dataset = {}; this.attributes = {};
    this.listeners = {}; this.textContent = ''; this._html = ''; this.ownedIds = [];
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  set innerHTML(value) {
    for (const id of this.ownedIds) elements.delete(id);
    this.ownedIds = []; this._html = value;
    for (const match of value.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
      const element = new Element(match[1]); element.hidden = /\shidden(?:\s|>)/.test(match[0]);
      elements.set(match[1], element); this.ownedIds.push(match[1]);
    }
  }
  get innerHTML() { return this._html; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'src') delete this.src; }
  addEventListener(key, callback) { (this.listeners[key] ??= []).push(callback); }
  querySelector() { return this.avatar ??= new Element(); }
  querySelectorAll() { return []; }
  replaceChildren() { this.innerHTML = ''; }
  focus() { document.activeElement = this; }
  click() { for (const handler of this.listeners.click || []) handler({ target: this }); }
  scrollIntoView() {}
  pause() { this.paused = true; }
  play() { this.paused = false; documentListeners.get('play')?.({ target: this }); return Promise.resolve(); }
  load() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  getBoundingClientRect() { return { left: 0, right: 500, top: 0, bottom: 500, width: 500, height: 500 }; }
  getContext() { return Object.fromEntries(['scale','clearRect','fillRect','beginPath','moveTo','lineTo','stroke'].map(name => [name, () => {}])); }
}

for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], new Element(match[1]));
for (const id of ['split-long-text', 'trim-silence']) elements.get(id).checked = true;
elements.get('speed').value = '1'; elements.get('seed').value = '0';
elements.get('duration-mode').value = 'auto'; elements.get('duration-seconds').value = '10';
const document = {
  getElementById: id => elements.get(id), querySelector: () => new Element(),
  querySelectorAll: selector => selector === 'audio' ? Array.from(elements.values()).filter(element => /player$/.test(element.id)) : [], addEventListener(type, callback) { documentListeners.set(type, callback); }, body: new Element(), documentElement: { lang: 'en' },
  createElement(tag) {
    if (tag === 'canvas') return { width: 0, height: 0, getContext: () => ({ drawImage(...args) { avatarDraws.push(args); } }), toBlob(callback, type) { callback(new Blob(['cropped-image-without-original-metadata'], { type })); } };
    return new Element();
  },
};
const storage = new Map([['wavegen.draft', 'Legacy English draft.'], ['wavegen.voice', 'a'.repeat(32)], ['wavegen.uiLocale.v1', 'ko']]);
const session = new Map();
const makeStorage = map => ({
  getItem: key => map.has(key) ? map.get(key) : null,
  setItem: (key, value) => map.set(key, String(value)),
  removeItem: key => map.delete(key),
});
const voice = {
  id: 'a'.repeat(32), name: 'Sample voice', reference_text: 'This is a sample voice.',
  audio_url: '/api/audio/voices/a', duration_seconds: 5,
};
let status = { state: 'ready', instance_id: 'one', request_id: '', can_cancel: false };
let history = [];
let planNeedsAuth = false;
let authRefreshes = 0;
let generationResolve = null;
let generationReject = null;
let historyResolve = null;
const historyWaiters = [];
let delayHistory = false;
const generatedRequests = [];
const planRequests = [];
const cancelRequests = [];
let seedSequence = 100;
let editBridge = null;
let editedOpened = null;
const response = (body, code = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: code });

async function mockFetch(input, options = {}) {
  const route = new URL(input, 'http://localhost:7887').pathname;
  if ((route === '/api/voices' && options.method === 'POST') || (route === '/api/voices/' + voice.id && options.method === 'PUT')) {
    voiceWrites.push(options.body);
    if (failVoiceSave) { failVoiceSave = false; return response({ error: 'Temporary write failure' }, 500); }
    return response({ voice: { ...voice, name: options.body.get('name'), reference_text: options.body.get('reference_text') } });
  }
  if (route === '/') { authRefreshes++; return response('<html>auth</html>'); }
  if (route.startsWith('/api/audio/enhancement/')) return new Response(enhancementWave, { headers: { 'Content-Type': 'audio/wav' } });
  if (route.startsWith('/api/audio/voices/')) { audioReads++; return new Response(new Uint8Array([1, 2, 3])); }
  if (route === '/api/status') return response(status);
  if (route === '/api/voices') return response({ voices: [voice], warnings: [] });
  if (route === '/api/trash') return response({ voices: [], warnings: [] });
  if (route === '/api/history') {
    if (delayHistory) return new Promise(resolve => {
      historyWaiters.push(resolve);
      historyResolve = () => { for (const waiter of historyWaiters.splice(0)) waiter(response({ items: history, warnings: [] })); };
    });
    return response({ items: history, warnings: [] });
  }
  if (route === '/api/plan') {
    if (planNeedsAuth) { planNeedsAuth = false; return response({ error: 'expired' }, 403); }
    planRequests.push(JSON.parse(options.body));
    return response({ duration_seconds: 3.25, segment_count: 1, prompt_frames: 250,
      segments: [{ text: JSON.parse(options.body).text, frames: 413, duration_seconds: 3.25 }] });
  }
  if (route === '/api/generate') {
    const body = JSON.parse(options.body); generatedRequests.push(body);
    status = { ...status, state: 'generating', request_id: body.request_id, can_cancel: true };
    return new Promise((resolve, reject) => { generationResolve = (result, code = 200) => resolve(response(result, code)); generationReject = reject; });
  }
  if (route === '/api/enhance') {
    const body = JSON.parse(options.body); enhancementRequests.push(body);
    status = { ...status, state: 'enhancing', request_id: body.request_id, can_cancel: true };
    return new Promise(resolve => { enhancementResolve = (result, code = 200) => resolve(response(result, code)); });
  }
  if (route === '/api/enhance/reference') {
    referenceEnhancementRequests.push(options.body);
    status = { ...status, state: 'enhancing', request_id: options.body.get('request_id'), can_cancel: true };
    return new Promise(resolve => { referenceEnhancementResolve = (result, code = 200) => resolve(response(result, code)); });
  }
  if (route === '/api/cancel') {
    const body = JSON.parse(options.body); cancelRequests.push(body);
    status = { ...status, cancel_requested: true, can_cancel: false };
    return response({ cancelled: true, request_id: body.request_id });
  }
  throw new Error('Unexpected mock route ' + route);
}

const exportNames = 'state,textIssue,currentDraft,applyDraft,readDraft,planKey,schedulePlan,loadPlan,generate,cancelGeneration,renderResults,renderHistory,reuseResult,openVoiceEditor,closeVoiceEditor,voiceEditorDirty,trimSamples,encodePcmWav,api,refreshHistory,refreshStatus,onDraftChanged,requestSettings,randomizeSeed,durationIssue,imageDimensions,prepareAvatar,chooseAvatar,resetAvatar,saveVoice,renderVoices,avatarContents,safeSourceUrl,modelId,modelIssue,modelResultLabel,renderModelControl,renderStatus,isBusy,chooseAudio,loadReferenceEditor,applyAudioProcessing,toggleTrim,enhanceExistingResult,enhanceReference,cancelReferenceEnhancement,applyReferenceEnhancement,discardReferenceEnhancement,enhancementAvailable,enhancementIssue';
assert(/\}\)\(\);\s*$/.test(productionSource), 'Frontend IIFE boundary changed; update test harness intentionally.');
const instrumentedSource = productionSource.replace(/\}\)\(\);\s*$/, `globalThis.__test={${exportNames}};})();`);
const windowListeners = new Map();
class TestURL extends URL {
  static createObjectURL() { const value = 'blob:mock-' + ++nextObjectUrl; activeObjectUrls.add(value); return value; }
  static revokeObjectURL(value) { revokedUrls.push(value); activeObjectUrls.delete(value); }
}
const decodedAudio = samples => ({ length: samples.length, duration: samples.length / 24000, sampleRate: 24000, getChannelData: () => samples });
class MockAudioContext {
  decodeAudioData(data) { if (!audioDecodeHandler) throw new Error('Audio decode fixture is not configured'); return audioDecodeHandler(data); }
  close() { return Promise.resolve(); }
}
class MockOfflineAudioContext {
  constructor(channels, frames, rate) { assert.equal(channels, 1); assert.equal(rate, 24000); this.frames = frames; this.destination = {}; }
  createBufferSource() { return this.source = { connect() {}, start() {} }; }
  startRendering() { assert.equal(this.source.buffer.length, this.frames); return Promise.resolve(this.source.buffer); }
}
const sandbox = {
  document, window: { AudioContext: MockAudioContext, OfflineAudioContext: MockOfflineAudioContext, addEventListener(type, callback) { windowListeners.set(type, callback); }, dispatchEvent(event) { windowListeners.get(event.type)?.(event); }, StudioSpeechEdit: { init(bridge) { editBridge = bridge; }, open(item) { editedOpened = item; }, refreshLocale() {} } }, location: { href: 'http://localhost:7887/', origin: 'http://localhost:7887' },
  CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  localStorage: makeStorage(storage), sessionStorage: makeStorage(session), fetch: mockFetch,
  Headers, Response, FormData, Blob, File, URL: TestURL, TextEncoder, crypto: { getRandomValues(array) { if (array instanceof Uint32Array) { array[0] = ++seedSequence; return array; } return crypto.webcrypto.getRandomValues(array); } },
  createImageBitmap: file => avatarDecodeHandler ? avatarDecodeHandler(file) : Promise.resolve({ width: 1024, height: 512, close() { bitmapCloses++; } }),
  HTMLMediaElement: Element, Uint8Array, Uint32Array, Float32Array, DataView, ArrayBuffer,
  OfflineAudioContext: MockOfflineAudioContext,
  Math, Number, Date, Error, TypeError, AbortController, Promise,
  setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
  clearTimeout: id => timers.delete(id),
};
vm.createContext(sandbox);
for (const filename of catalogNames) vm.runInContext(fs.readFileSync(path.join(webRoot, filename), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(webRoot, 'reference-editor.js'), 'utf8'), sandbox, { filename: 'reference-editor.js' });
vm.runInContext(instrumentedSource, sandbox);
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const checks = [];
const passed = name => checks.push({ name, passed: true });

async function main() {
  await flush();
  const t = sandbox.__test;
  assert.equal(t.currentDraft().text, 'Legacy English draft.');
  assert.equal(JSON.parse(storage.get('wavegen.draft.v1')).version, 1);
  passed('Legacy draft migration');

  t.applyDraft({ text: 'Updated draft.', voice_id: voice.id, speed: 1.25, seed: 17, split_long_text: false });
  const saved = JSON.parse(storage.get('wavegen.draft.v1'));
  assert.equal(saved.speed, 1.25); assert.equal(saved.seed, 17); assert.equal(saved.split_long_text, false);
  passed('Whole draft and options persistence');

  assert.equal(t.textIssue('“Hello.”', 5000, '문장'), '');
  assert(t.textIssue('Hello — world.', 5000, '문장'));
  assert(t.textIssue('“'.repeat(1700), 5000, '문장'));
  passed('English and UTF8 byte validation');

  planNeedsAuth = true;
  await t.loadPlan(t.planKey(), t.state.planRevision);
  assert.equal(t.state.plan.state, 'ready'); assert.equal(authRefreshes, 1);
  assert.equal(t.state.plan.value.duration_seconds, 3.25);
  passed('403 cookie reauthentication and exact server plan');

  const before = t.state.plan;
  await t.loadPlan('obsolete', t.state.planRevision - 1);
  assert.equal(t.state.plan, before);
  passed('Stale plan result ignored');

  const previous = t.currentDraft();
  t.reuseResult({ text: 'Historical draft.', voice_id: 'missing', speed: .75, seed: 99, split_long_text: true });
  assert.equal(t.state.selectedId, ''); assert.equal(generatedRequests.length, 0);
  elements.get('toast-action').listeners.click[0]();
  assert.equal(t.currentDraft().text, previous.text); assert.equal(t.currentDraft().speed, previous.speed);
  assert.equal(t.state.selectedId, voice.id);
  passed('History reuse with missing voice and undo without generation');

  t.openVoiceEditor(voice);
  elements.get('voice-name').value = 'Unsaved name';
  t.closeVoiceEditor();
  assert(t.state.modal); assert.equal(elements.get('voice-discard-confirmation').hidden, false);
  t.closeVoiceEditor(true); assert.equal(t.state.modal, null);
  passed('Unsaved editor preserves state until explicit discard');

  t.state.history = Array.from({ length: 15 }, (_, i) => ({ id: String(i), text: 'Stored ' + i, voice_name: 'Sample', created_at: '2026-11-12T00:00:00Z' }));
  t.state.historyQuery = ''; t.state.historyLimit = 12; t.renderHistory();
  assert.equal(elements.get('history-more').hidden, false);
  t.state.historyQuery = 'Stored 14'; t.renderHistory();
  assert(elements.get('history-list').innerHTML.includes('Stored 14'));
  passed('History search reaches records beyond the first twelve');
  t.state.history = []; t.state.historyQuery = '';

  t.applyDraft({ text: 'Generation transaction test.', voice_id: voice.id, speed: 1, seed: 0, split_long_text: true });
  await t.loadPlan(t.planKey(), t.state.planRevision);
  const generation = t.generate(); await flush();
  assert(t.state.generating); assert.match(generatedRequests.at(-1).request_id, /^[a-f0-9]{32}$/);
  const requestId = generatedRequests.at(-1).request_id;
  history = [{ id: 'result-one', text: 'Generation transaction test.', voice_id: voice.id, voice_name: voice.name,
    created_at: '2026-11-12T00:00:00Z', audio_url: '/api/audio/outputs/result-one', request_id: requestId }];
  delayHistory = true; status = { ...status, state: 'ready', request_id: '', can_cancel: false };
  generationResolve(history[0]); await flush();
  assert(t.state.generating); assert(historyResolve);
  delayHistory = false; historyResolve(); await generation;
  assert.equal(t.state.generating, false);
  passed('Generation busy lock includes delayed history refresh');

  t.applyDraft({ text: 'Cancel test.', voice_id: voice.id, speed: 1, seed: 0, split_long_text: true });
  await t.loadPlan(t.planKey(), t.state.planRevision);
  const cancelled = t.generate(); await flush();
  const cancelId = t.state.request.id;
  await t.cancelGeneration(); assert.equal(cancelRequests.at(-1).request_id, cancelId);
  status = { ...status, state: 'ready', request_id: '', can_cancel: false, cancel_requested: false };
  generationResolve({ cancelled: true, request_id: cancelId }); await cancelled;
  assert.equal(t.state.generating, false); assert.equal(t.state.request, null);
  assert.equal(t.currentDraft().text, 'Cancel test.');
  passed('Cancellation targets current request and preserves draft');

  const samples = new Float32Array(6 * 24000);
  for (let i = 48000; i < 72000; i++) samples[i] = .2 * Math.sin(2 * Math.PI * 220 * i / 24000);
  assert.equal(t.trimSamples(samples, true).samples.length, 31200);
  assert.equal(t.trimSamples(samples, false).samples.length, samples.length);
  passed('Existing trim edge padding and toggle behavior unchanged');

  let changingVoice = { id: 'v', updated_at: 't1', duration_seconds: 5, reference_text: 'First transcript' };
  const keyContext = { currentDraft: () => ({ voice_id: 'v', text: 'Hello.', speed: 1, split_long_text: true }), selectedVoice: () => changingVoice };
  vm.createContext(keyContext);
  vm.runInContext(productionSource.slice(productionSource.indexOf('  function planKey()'), productionSource.indexOf('  function schedulePlan(')), keyContext);
  const firstKey = keyContext.planKey(); changingVoice = { ...changingVoice, reference_text: 'Updated transcript' };
  assert.notEqual(keyContext.planKey(), firstKey);
  passed('Transcript edits invalidate forecast');
  const secondKey = keyContext.planKey(); changingVoice = { ...changingVoice, duration_seconds: 7 };
  assert.notEqual(keyContext.planKey(), secondKey);
  passed('Reference duration edits invalidate forecast');

  let completeOldCancel;
  const cancelState = { request: { id: 'old' }, cancelPending: false };
  const notices = [];
  const cancelContext = { state: cancelState, api: () => new Promise(resolve => { completeOldCancel = resolve; }),
    showToast: value => notices.push(value), updateGenerateButton() {}, storePending() {}, refreshStatus: async () => {}, readableError: () => '' };
  vm.createContext(cancelContext);
  vm.runInContext(productionSource.slice(productionSource.indexOf('  async function cancelGeneration()'), productionSource.indexOf('  function scheduleStatusPoll(')), cancelContext);
  const oldCancel = cancelContext.cancelGeneration();
  cancelState.request = { id: 'new' }; cancelState.cancelPending = true;
  completeOldCancel({ cancelled: true, request_id: 'old' }); await oldCancel;
  assert.equal(cancelState.cancelPending, true); assert.equal(cancelState.request.id, 'new'); assert.equal(notices.length, 0);
  passed('Late old cancel response preserves new request ownership');

  t.state.activeResultId = 'result-one'; t.renderResults();
  const audio = elements.get('generated-player'); audio.currentTime = 1.2;
  t.openVoiceEditor(voice);
  elements.get('voice-name').value = 'Keep my voice name';
  elements.get('reference-text').value = 'Keep this exact transcript.';
  const original = new Float32Array([.1, .2]);
  const selectedFile = new File(['voice'], 'User file.wav');
  Object.assign(t.state.modal, { original, file: selectedFile, filename: selectedFile.name, audioDirty: true });
  const modal = t.state.modal, referenceAudio = elements.get('reference-player');
  const unchangedDraft = JSON.stringify(t.currentDraft()), requestCount = generatedRequests.length;
  const revision = t.state.planRevision;
  for (const locale of ['en', 'zh', 'ja', 'ko']) {
    sandbox.window.StudioI18n.setLocale(locale);
    assert.equal(elements.get('generated-player'), audio); assert.equal(audio.currentTime, 1.2);
    assert.equal(elements.get('reference-player'), referenceAudio);
    assert.equal(t.state.modal, modal); assert.equal(modal.original, original); assert.equal(modal.file, selectedFile);
    assert.equal(elements.get('voice-name').value, 'Keep my voice name');
    assert.equal(elements.get('reference-text').value, 'Keep this exact transcript.');
    assert.equal(JSON.stringify(t.currentDraft()), unchangedDraft);
    assert.equal(t.state.planRevision, revision); assert.equal(generatedRequests.length, requestCount);
    assert.equal(elements.get('ui-language').value, locale);
    assert.equal(document.documentElement.lang, locale === 'zh' ? 'zh-CN' : locale);
  }
  t.closeVoiceEditor(true);
  passed('Live locale switches preserve drafts, editor buffers, audio node and playback without new requests');

  t.applyDraft({ ...t.currentDraft(), text: 'Unsupported — and … punctuation.' });
  assert.equal(t.state.plan.state, 'invalid');
  for (const locale of ['en', 'zh', 'ja', 'ko']) {
    sandbox.window.StudioI18n.setLocale(locale);
    const translate = sandbox.window.StudioI18n.t;
    assert.equal(elements.get('generation-error').textContent, t.textIssue(t.currentDraft().text, 5000, translate('validation.generationLabel')));
    assert.equal(sandbox.window.StudioI18n.translate('Invalid stored voice profile fields'), 'Invalid stored voice profile fields');
    assert.equal(sandbox.window.StudioI18n.translate('Result abc: Invalid stored history fields'), 'Result abc: Invalid stored history fields');
    assert.equal(sandbox.window.StudioI18n.translate('1.5s'), translate('common.durationSeconds', { seconds: '1.5' }));
  }
  passed('Composite validation errors relocalize while unknown technical details remain byte-for-byte intact');

  t.applyDraft({ text: 'A controlled duration test.', voice_id: voice.id, speed: 1.25, seed: 17, randomize_seed: false, duration_mode: 'target', duration_seconds: 7.5, split_long_text: true });
  let stored = JSON.parse(storage.get('wavegen.draft.v1'));
  assert.equal(stored.duration_mode, 'target'); assert.equal(stored.duration_seconds, 7.5); assert.equal(stored.randomize_seed, false);
  assert.equal(t.readDraft().duration_seconds, 7.5); assert.equal(elements.get('speed').disabled, true);
  await t.loadPlan(t.planKey(), t.state.planRevision);
  assert.equal(planRequests.at(-1).duration_seconds, 7.5); assert.equal(planRequests.at(-1).speed, 1);
  assert.equal(t.currentDraft().speed, 1.25);
  const targetKey = t.planKey();
  elements.get('duration-seconds').value = '8'; t.onDraftChanged(); assert.notEqual(t.planKey(), targetKey);
  elements.get('duration-mode').value = 'auto'; t.onDraftChanged();
  assert.equal(elements.get('speed').disabled, false); assert.equal(t.currentDraft().speed, 1.25);
  await t.loadPlan(t.planKey(), t.state.planRevision);
  assert.equal(Object.hasOwn(planRequests.at(-1), 'duration_seconds'), false);
  assert.equal(planRequests.at(-1).speed, 1.25);
  passed('Target duration persists, invalidates forecasts, overrides API speed and restores automatic speed');

  elements.get('duration-mode').value = 'target';
  const plansBeforeInvalid = planRequests.length;
  for (const value of ['', '0.19', '600.1', 'not-a-number']) {
    elements.get('duration-seconds').value = value; t.onDraftChanged();
    assert.equal(t.state.plan.state, 'invalid'); assert.equal(elements.get('generate-button').disabled, true);
    assert(t.durationIssue());
    for (const locale of ['en', 'zh', 'ja', 'ko']) {
      sandbox.window.StudioI18n.setLocale(locale);
      assert.equal(elements.get('generation-error').textContent, sandbox.window.StudioI18n.t('features.durationError'));
    }
  }
  assert.equal(planRequests.length, plansBeforeInvalid);
  for (const value of ['0.2', '600']) { elements.get('duration-seconds').value = value; t.onDraftChanged(); assert.equal(t.durationIssue(), ''); }
  passed('Duration bounds reject invalid input locally with live localized errors and accept both endpoints');

  t.applyDraft({ ...t.currentDraft(), duration_seconds: 7.5, seed: 17, randomize_seed: false });
  await t.loadPlan(t.planKey(), t.state.planRevision);
  const revisionBeforeSeed = t.state.planRevision, plansBeforeSeed = planRequests.length;
  t.randomizeSeed();
  assert.equal(t.currentDraft().seed, 101); assert.equal(JSON.parse(storage.get('wavegen.draft.v1')).seed, 101);
  assert.equal(t.state.planRevision, revisionBeforeSeed); assert.equal(planRequests.length, plansBeforeSeed);
  assert.equal(t.state.plan.state, 'ready');
  passed('One-click random seed uses cryptographic uint32 input without replanning or generating');

  elements.get('seed-every-time').checked = true;
  elements.get('seed-every-time').listeners.change[0]();
  assert.equal(JSON.parse(storage.get('wavegen.draft.v1')).randomize_seed, true);
  const usedSeeds = [];
  for (let index = 0; index < 2; index++) {
    const active = t.generate(); await flush();
    const request = generatedRequests.at(-1); usedSeeds.push(request.seed);
    assert.equal(request.seed, 102 + index); assert.equal(request.duration_seconds, 7.5); assert.equal(request.speed, 1);
    assert.equal(t.state.request.draft.seed, request.seed); assert.equal(t.currentDraft().seed, request.seed);
    const result = { id: 'seed-result-' + index, text: request.text, voice_id: voice.id, voice_name: voice.name, seed: request.seed, speed: request.speed,
      duration_mode: 'fixed', requested_duration_seconds: 7.5, duration_seconds: 7.5, split_long_text: true,
      audio_url: '/api/audio/outputs/seed-result-' + index, created_at: new Date().toISOString(), request_id: request.request_id };
    history = [result, ...history]; status = { ...status, state: 'ready', request_id: '', can_cancel: false, cancel_requested: false };
    generationResolve(result); await active;
    assert(elements.get('result-settings').textContent.includes(String(request.seed)));
  }
  assert.notEqual(usedSeeds[0], usedSeeds[1]);
  passed('Every-generation randomization sends and displays the exact seed saved with each fixed-duration result');

  const beforeReuse = JSON.stringify(t.currentDraft());
  t.reuseResult(history[0]);
  assert.equal(t.currentDraft().seed, usedSeeds[1]); assert.equal(t.currentDraft().randomize_seed, false);
  assert.equal(t.currentDraft().duration_mode, 'target'); assert.equal(t.currentDraft().duration_seconds, 7.5);
  elements.get('toast-action').listeners.click[0](); assert.equal(JSON.stringify(t.currentDraft()), beforeReuse);
  t.reuseResult({ text: 'Old automatic result.', voice_id: voice.id, seed: 9, duration_seconds: 14 });
  assert.equal(t.currentDraft().duration_mode, 'auto'); assert.equal(Object.hasOwn(t.requestSettings(), 'duration_seconds'), false);
  passed('History reuse restores actual seed and requested target, disables fresh randomization and supports undo plus old history');

  const originalResult = history[0];
  t.state.activeResultId = originalResult.id; t.renderResults();
  elements.get('speech-edit-result').listeners.click[0](); assert.equal(editedOpened.id, originalResult.id);
  assert.equal(editBridge.getVoices()[0].id, voice.id);
  editBridge.onBusyChange(true); assert.equal(t.state.speechEditing, true);
  assert.equal(editBridge.getStatus().state, 'generating'); assert.equal(elements.get('generate-button').disabled, true);
  const requestsBeforeEdit = generatedRequests.length; await t.generate(); assert.equal(generatedRequests.length, requestsBeforeEdit);
  const edited = { ...originalResult, id: 'edited-one', audio_url: '/api/audio/outputs/edited-one', transcript_stale: true, edit: { text: 'Replacement phrase.' } };
  history = [edited, ...history]; await editBridge.onResult(edited);
  assert.equal(t.state.activeResultId, edited.id); assert.equal(t.state.history.filter(item => item.id === edited.id).length, 1);
  assert.equal(elements.get('result-transcript-notice').hidden, false);
  await editBridge.onResult(originalResult); assert.equal(t.state.activeResultId, originalResult.id);
  assert.equal(t.state.history.filter(item => item.id === originalResult.id).length, 1);
  editBridge.onBusyChange(false); assert.equal(t.state.speechEditing, false);
  t.reuseResult(edited); assert.equal(t.currentDraft().text, originalResult.text);
  for (const locale of ['en', 'zh', 'ja', 'ko']) {
    sandbox.window.StudioI18n.setLocale(locale);
    assert(elements.get('toast-message').textContent.includes(sandbox.window.StudioI18n.t('features.editedReuseWarning')));
  }
  passed('Speech Edit bridge blocks concurrent synthesis, selects immutable results and undo, and warns when reusing stale transcript');

  const pngHeader = (width, height) => {
    const bytes = new Uint8Array(24), view = new DataView(bytes.buffer);
    bytes.set([137,80,78,71,13,10,26,10]); view.setUint32(8, 13); bytes.set([73,72,68,82], 12);
    view.setUint32(16, width); view.setUint32(20, height); return bytes.buffer;
  };
  assert.equal(t.imageDimensions(pngHeader(1024, 512)).width, 1024);
  const jpeg = new Uint8Array([255,216,255,192,0,11,8,1,44,1,144,1,1,17,0]);
  assert.equal(t.imageDimensions(jpeg.buffer).width, 400); assert.equal(t.imageDimensions(jpeg.buffer).height, 300);
  for (const type of ['VP8X', 'VP8 ', 'VP8L']) {
    const size = type === 'VP8L' ? 5 : 10, bytes = new Uint8Array(20 + size), view = new DataView(bytes.buffer);
    bytes.set(Buffer.from('RIFF')); view.setUint32(4, bytes.length - 8, true); bytes.set(Buffer.from('WEBP' + type), 8); view.setUint32(16, size, true);
    if (type === 'VP8X') { bytes[24] = 255; bytes[27] = 127; }
    if (type === 'VP8 ') { bytes.set([157,1,42], 23); view.setUint16(26, 256, true); view.setUint16(28, 128, true); }
    if (type === 'VP8L') { bytes[20] = 47; view.setUint32(21, 255 | (127 << 14), true); }
    assert.equal(t.imageDimensions(bytes.buffer).width, 256); assert.equal(t.imageDimensions(bytes.buffer).height, 128);
  }
  for (const dimensions of [[0,1], [9000,1], [5000,5000]]) assert.throws(() => t.imageDimensions(pngHeader(...dimensions)));
  assert.throws(() => t.imageDimensions(new TextEncoder().encode('<svg onload="alert(1)"></svg>').buffer));
  let decodeCount = 0; avatarDecodeHandler = async () => { decodeCount++; throw new Error('Must not reach image decode'); };
  await assert.rejects(() => t.prepareAvatar(new File([pngHeader(5000,5000)], 'oversized.png')));
  await assert.rejects(() => t.prepareAvatar({ size: 10 * 1024 * 1024 + 1, arrayBuffer: async () => pngHeader(1,1) }));
  assert.equal(decodeCount, 0); avatarDecodeHandler = null;
  passed('PNG/JPEG/all WebP dimension headers are checked and oversized or unsupported images are rejected before decoding');

  const originalImage = new File([pngHeader(1024,512), 'private-camera-location'], 'My image.png', { type: 'image/png' });
  const prepared = await t.prepareAvatar(originalImage);
  assert.equal(prepared.type, 'image/png'); assert.equal(prepared.name, 'character.png');
  assert.deepEqual(avatarDraws.at(-1).slice(1), [256,0,512,512,0,0,512,512]);
  assert.equal((await prepared.text()).includes('private-camera-location'), false); assert(bitmapCloses > 0);
  passed('Avatar processing requests a 512-square center crop and encodes a fresh PNG without copying input metadata');

  const presetVoice = { ...voice, name: 'Mira <test>', avatar_url: '/api/avatars/mira.png', preset: true, builtin: false,
    source: { dataset: 'Licensed source <safe>', url: 'javascript:alert(1)', attribution: 'Credit <speaker>', fictional_character: true },
    license: { title: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', notice: '</pre><img src=x onerror=alert(1)> Original notice.' } };
  t.openVoiceEditor(presetVoice);
  assert.equal(elements.get('voice-source').hidden, false);
  const terms = elements.get('voice-source-content').innerHTML;
  assert(terms.includes('&lt;img')); assert(terms.includes('Credit &lt;speaker&gt;'));
  assert(!terms.includes('href="javascript:')); assert(terms.includes('https://creativecommons.org/licenses/by/4.0/'));
  assert(terms.includes(sandbox.window.StudioI18n.t('libraryX.modelTerms')));
  assert(t.avatarContents(presetVoice).includes('data-voice-avatar'));
  assert(!t.avatarContents({ ...voice, avatar_url: 'https://outside.example/image.png' }).includes('<img'));
  let failedImageRemoved = false;
  documentListeners.get('error')({ target: { matches: selector => selector === 'img[data-voice-avatar]', remove() { failedImageRemoved = true; } } });
  assert.equal(failedImageRemoved, true);
  t.closeVoiceEditor(true);
  passed('Preset source notices are escaped, links and avatars use safe URL policies, and failed avatars fall back to initials');

  t.openVoiceEditor(presetVoice); await t.chooseAvatar(originalImage);
  const avatarDraft = t.state.modal, pendingAvatar = avatarDraft.avatarFile, avatarUrl = avatarDraft.avatarPreviewUrl;
  assert.equal(avatarDraft.avatarSource, originalImage); assert.equal(t.voiceEditorDirty(), true);
  t.closeVoiceEditor(); assert.equal(t.state.modal, avatarDraft); assert.equal(elements.get('voice-discard-confirmation').hidden, false);
  for (const locale of ['en', 'zh', 'ja', 'ko']) {
    sandbox.window.StudioI18n.setLocale(locale);
    assert.equal(t.state.modal.avatarFile, pendingAvatar); assert.equal(t.state.modal.avatarSource, originalImage);
    assert.equal(t.state.modal.avatarPreviewUrl, avatarUrl); assert(activeObjectUrls.has(avatarUrl));
  }
  t.closeVoiceEditor(true); assert(revokedUrls.includes(avatarUrl));
  passed('Image drafts participate in unsaved confirmation, survive four locale switches, and release preview URLs on discard');

  const decodes = new Map();
  avatarDecodeHandler = file => new Promise(resolve => decodes.set(file.name, resolve));
  const firstImage = new File([pngHeader(1024,512)], 'first.png'), secondImage = new File([pngHeader(1024,512)], 'second.png');
  const bitmap = () => ({ width: 1024, height: 512, close() { bitmapCloses++; } });
  t.openVoiceEditor(presetVoice); const firstJob = t.chooseAvatar(firstImage), secondJob = t.chooseAvatar(secondImage); await flush();
  decodes.get('second.png')(bitmap()); await secondJob; const secondPreview = t.state.modal.avatarPreviewUrl;
  decodes.get('first.png')(bitmap()); await firstJob;
  assert.equal(t.state.modal.avatarSource, secondImage); assert.equal(t.state.modal.avatarPreviewUrl, secondPreview);
  const closeImage = new File([pngHeader(1024,512)], 'closing.png'), closingJob = t.chooseAvatar(closeImage); await flush();
  t.closeVoiceEditor(true); t.openVoiceEditor(voice); const freshDraft = t.state.modal;
  decodes.get('closing.png')(bitmap()); await closingJob;
  assert.equal(t.state.modal, freshDraft); assert.equal(freshDraft.avatarFile, null); assert(!activeObjectUrls.has(secondPreview));
  avatarDecodeHandler = null; t.closeVoiceEditor(true);
  passed('Out-of-order image decodes and decode completion after reopening cannot replace the current profile image');

  t.openVoiceEditor(presetVoice); await t.chooseAvatar(originalImage);
  const retryDraft = t.state.modal, retryFile = retryDraft.avatarFile, retryUrl = retryDraft.avatarPreviewUrl;
  assert.equal(elements.get('trim-silence').checked, true);
  assert.equal(retryDraft.audioDirty, false); assert.equal(retryDraft.original, null); assert.equal(retryDraft.file, null);
  failVoiceSave = true; await t.saveVoice({ preventDefault() {} });
  assert.equal(t.state.modal, retryDraft); assert.equal(retryDraft.avatarFile, retryFile); assert.equal(retryDraft.avatarSource, originalImage);
  assert.equal(retryDraft.avatarPreviewUrl, retryUrl); assert.equal(elements.get('voice-save').disabled, false);
  const failedPayload = voiceWrites.at(-1); assert.equal(failedPayload.get('avatar').type, 'image/png');
  assert.equal(failedPayload.has('remove_avatar'), false); assert.equal(failedPayload.has('audio'), false);
  for (const field of ['original_audio', 'trim_enabled', 'trim_start_seconds', 'trim_end_seconds', 'original_duration_seconds']) assert.equal(failedPayload.has(field), false);
  assert.equal(failedPayload.get('reference_text'), presetVoice.reference_text);
  assert.equal(failedPayload.has('source'), false); assert.equal(failedPayload.has('license'), false);
  await t.saveVoice({ preventDefault() {} }); assert.equal(t.state.modal, null); assert(revokedUrls.includes(retryUrl));
  t.openVoiceEditor(presetVoice); t.resetAvatar(true); assert.equal(document.activeElement, elements.get('avatar-choose')); await t.saveVoice({ preventDefault() {} });
  assert.equal(voiceWrites.at(-1).get('remove_avatar'), 'true'); assert.equal(voiceWrites.at(-1).has('avatar'), false);
  t.openVoiceEditor(presetVoice); await t.chooseAvatar(originalImage); t.resetAvatar(); assert.equal(document.activeElement, elements.get('avatar-choose')); await t.saveVoice({ preventDefault() {} });
  assert.equal(voiceWrites.at(-1).has('avatar'), false); assert.equal(voiceWrites.at(-1).has('remove_avatar'), false);
  assert.equal(activeObjectUrls.size, 0);
  passed('Failed saves preserve both original and prepared images for retry; remove/reset payloads preserve audio and catalog provenance');

  const avatarInputTag = html.match(/<input\b[^>]*\bid="voice-avatar"[^>]*>/)?.[0];
  const css = fs.readFileSync(path.join(webRoot, 'style.css'), 'utf8');
  assert(avatarInputTag && /\shidden(?:\s|>)/.test(avatarInputTag), 'Avatar picker must be excluded from layout and pointer hit testing');
  assert(!/class="[^"]*\bfile-input\b/.test(avatarInputTag), 'The full-surface audio-dropzone overlay class must not be reused outside its positioned parent');
  assert(/#voice-avatar\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/.test(css), 'Author CSS must preserve display:none so a hidden file input cannot cover profile buttons');
  t.openVoiceEditor(presetVoice);
  let pickerOpens = 0; elements.get('voice-avatar').listeners.click = [() => pickerOpens++];
  elements.get('avatar-choose').click(); assert.equal(pickerOpens, 1);
  elements.get('avatar-remove').click(); assert.equal(pickerOpens, 1); assert.equal(t.state.modal.avatarRemove, true);
  elements.get('avatar-reset').click(); assert.equal(pickerOpens, 1); assert.equal(t.state.modal.avatarRemove, false);
  t.closeVoiceEditor(true);
  passed('Avatar file input has no layout or pointer overlay; only Choose opens the picker while Remove and Undo remain independent');

  assert.equal(t.modelId(undefined), 'flash'); assert.equal(t.modelId(null), 'flash');
  assert.equal(t.modelId('future-model'), 'future-model'); assert.equal(t.modelId(''), '');
  t.applyDraft({ text: 'A model selection draft.', voice_id: voice.id, seed: 51, speed: 1.25 });
  assert.equal(t.currentDraft().model_id, 'flash');
  assert.equal(t.requestSettings().model_id, 'flash');
  passed('Legacy drafts and history default only missing model IDs to Flash; explicit unknown IDs remain detectable');

  status = { ...status, state: 'ready', models: [
    { id: 'flash', name: 'Flash', steps: 4, available: true, loaded: true, load_count: 1 },
    { id: 'vspec', name: 'V-Spec', steps: 50, available: true, loaded: false, load_count: 0 },
  ] };
  t.state.status = status;
  const changeMode = value => { elements.get('generation-model').value = value; elements.get('generation-model').listeners.change[0]({ target: elements.get('generation-model') }); };
  const flashKey = t.planKey(), callsBeforeMode = generatedRequests.length;
  const preservedText = t.currentDraft().text, preservedSeed = t.currentDraft().seed;
  changeMode('vspec');
  assert.equal(t.currentDraft().model_id, 'vspec'); assert.equal(t.readDraft().model_id, 'vspec');
  assert.equal(t.currentDraft().text, preservedText); assert.equal(t.currentDraft().seed, preservedSeed);
  assert.notEqual(t.planKey(), flashKey); assert.equal(generatedRequests.length, callsBeforeMode);
  assert(elements.get('generation-model-hint').textContent.includes('V-Spec'));
  assert.equal(editBridge.modelIssue('vspec'), '');
  await t.loadPlan(t.planKey(), t.state.planRevision);
  assert.equal(planRequests.at(-1).model_id, 'vspec');
  passed('Mode selection preserves text and seed, persists without allocating a model, invalidates the plan and sends V-Spec explicitly');

  const vspecRun = t.generate(); await flush();
  const vspecRequest = generatedRequests.at(-1);
  assert.equal(vspecRequest.model_id, 'vspec'); assert.equal(vspecRequest.seed, preservedSeed);
  assert.equal(elements.get('generation-model').disabled, true);
  changeMode('flash'); assert.equal(t.currentDraft().model_id, 'vspec');
  t.reuseResult({ text: 'Must not overwrite a busy draft.', voice_id: voice.id });
  assert.equal(t.currentDraft().text, preservedText);
  status = { ...status, state: 'loading_model', active_model_id: 'vspec', request_id: vspecRequest.request_id, can_cancel: true, step_index: 0, step_count: 50 };
  await t.refreshStatus();
  assert(t.isBusy()); assert.equal(elements.get('generation-model').disabled, true);
  assert(elements.get('model-status-text').textContent.includes('V-Spec'));
  assert.equal(elements.get('cancel-generation').disabled, false);
  const vspecResult = { id: 'vspec-result', text: preservedText, voice_id: voice.id, voice_name: voice.name, model_id: 'vspec', model_name: 'V-Spec', steps: 50, seed: preservedSeed, duration_seconds: 4, audio_url: '/api/audio/outputs/vspec-result', request_id: vspecRequest.request_id, created_at: '2026-11-12T00:00:00Z' };
  history = [vspecResult, ...history];
  status = { ...status, state: 'ready', request_id: '', can_cancel: false, models: status.models.map(model => ({ ...model, loaded: true, load_count: 1 })) };
  generationResolve(vspecResult); await vspecRun;
  assert.equal(elements.get('generation-model').disabled, false);
  assert(elements.get('result-settings').textContent.includes('V-Spec'));
  assert(t.modelResultLabel({ ...vspecResult, model_scope: 'replacement' }).includes(sandbox.window.StudioI18n.t('models.replacementResult', { mode: t.modelResultLabel(vspecResult) })));
  passed('Generation locks mode changes through lazy model loading, keeps cancellation available, and labels recorded model provenance');

  for (const locale of ['ko', 'zh', 'ja', 'en']) {
    sandbox.window.StudioI18n.setLocale(locale);
    assert.equal(t.currentDraft().model_id, 'vspec'); assert.equal(t.currentDraft().text, preservedText);
    assert(elements.get('generation-model').innerHTML.includes(sandbox.window.StudioI18n.t('models.vspec')));
  }
  const beforeModelReuse = t.currentDraft();
  t.reuseResult({ text: 'Legacy recording.', voice_id: voice.id, seed: 0 });
  assert.equal(t.currentDraft().model_id, 'flash');
  elements.get('toast-action').listeners.click[0]();
  assert.equal(t.currentDraft().model_id, beforeModelReuse.model_id); assert.equal(t.currentDraft().text, beforeModelReuse.text);
  t.reuseResult(vspecResult); assert.equal(t.currentDraft().model_id, 'vspec');
  passed('Four-locale switching and history reuse/undo retain model intent without leaking into or erasing the draft');

  t.applyDraft({ text: 'Keep this unsupported draft.', voice_id: voice.id, model_id: 'future-model' });
  assert.equal(t.currentDraft().model_id, 'future-model'); assert.equal(t.readDraft().model_id, 'future-model');
  assert.equal(t.state.plan.state, 'invalid'); assert.equal(elements.get('generate-button').disabled, true);
  assert(elements.get('generation-error').textContent.includes('future-model'));
  const callsBeforeInvalidModel = generatedRequests.length; await t.generate(); assert.equal(generatedRequests.length, callsBeforeInvalidModel);
  status = { ...status, models: status.models.map(model => model.id === 'vspec' ? { ...model, available: false, loaded: false } : model) }; t.state.status = status;
  t.applyDraft({ text: 'Keep this unavailable draft.', voice_id: voice.id, model_id: 'vspec' });
  assert.equal(t.currentDraft().model_id, 'vspec'); assert(t.modelIssue().includes('V-Spec'));
  assert.equal(elements.get('generate-button').disabled, true); assert.equal(t.state.plan.state, 'invalid');
  changeMode('flash'); assert.equal(t.currentDraft().text, 'Keep this unavailable draft.'); assert.equal(t.modelIssue(), '');
  passed('Unknown and missing model files never silently fall back to Flash; an explicit available selection repairs the unchanged draft');

  const referenceApi = sandbox.window.StudioReferenceEditor;
  const pcmHash = values => crypto.createHash('sha256').update(Buffer.from(values.buffer, values.byteOffset, values.byteLength)).digest('hex');
  const audioFixture = (amplitude = .2) => {
    const values = new Float32Array(6 * 24000);
    for (let i = 2 * 24000; i < 3 * 24000; i++) values[i] = amplitude * Math.sin(2 * Math.PI * 220 * i / 24000);
    return values;
  };
  const sourceSamples = audioFixture(), sourceHash = pcmHash(sourceSamples);
  audioDecodeHandler = async () => decodedAudio(sourceSamples);
  const editedVoice = { ...voice, original_audio_url: '/api/audio/voices/' + voice.id + '/original',
    reference_edit_version: 1, selection_start_seconds: 1, selection_end_seconds: 4,
    trim_enabled: false, normalize_enabled: true, normalization_gain_db: 10.9794,
    trim_start_seconds: 1, trim_end_seconds: 2, original_duration_seconds: 6, duration_seconds: 3 };
  const writesBeforeOpen = voiceWrites.length, readsBeforeOpen = audioReads;
  t.openVoiceEditor(editedVoice);
  assert.equal(audioReads, readsBeforeOpen); assert.equal(voiceWrites.length, writesBeforeOpen);
  assert.equal(t.state.modal.original, null); assert.equal(referenceApi.getSettings(), null);
  await t.loadReferenceEditor();
  assert.equal(audioReads, readsBeforeOpen + 1); assert.equal(voiceWrites.length, writesBeforeOpen);
  assert.equal(t.state.modal.audioDirty, false); assert.equal(t.state.modal.file, null);
  assert.equal(t.state.modal.newSource, false); assert.equal(t.voiceEditorDirty(), false);
  assert.equal(referenceApi.getSettings().startSeconds, 1); assert.equal(referenceApi.getSettings().endSeconds, 4);
  assert.equal(referenceApi.getSettings().normalizeEnabled, true);
  assert.equal(new URL(elements.get('reference-player').src).pathname, editedVoice.audio_url);
  const savedSettings = JSON.stringify(referenceApi.getSettings()), readsBeforeLocales = audioReads;
  for (const locale of ['en', 'ko', 'zh', 'ja']) {
    sandbox.window.StudioI18n.setLocale(locale);
    const translate = sandbox.window.StudioI18n.t;
    assert.equal(elements.get('reference-original-length').textContent, translate('referenceX.originalLength', { duration: '6.00' }));
    assert.equal(elements.get('reference-range-summary').textContent, translate('referenceX.range', { start: '1.00', end: '4.00', duration: '3.00' }));
    assert.equal(JSON.stringify(referenceApi.getSettings()), savedSettings);
    assert.equal(t.state.modal.audioDirty, false); assert.equal(t.state.modal.file, null);
    assert.equal(audioReads, readsBeforeLocales); assert.equal(voiceWrites.length, writesBeforeOpen);
  }
  elements.get('voice-name').value = 'Metadata-only rename';
  await t.saveVoice({ preventDefault() {} });
  for (const key of ['audio', 'original_audio', 'reference_edit_version', 'selection_start_seconds', 'normalization_gain_db']) assert.equal(voiceWrites.at(-1).has(key), false);
  assert.equal(pcmHash(sourceSamples), sourceHash);
  passed('Opening and loading a saved manual selection are read-only; metadata-only save does not re-encode audio or overwrite the stored original');

  t.openVoiceEditor(editedVoice); await t.loadReferenceEditor();
  const editedDraft = t.state.modal;
  elements.get('trim-silence').checked = true; t.toggleTrim();
  assert.equal(referenceApi.getSettings().startSeconds, 1); assert.equal(referenceApi.getSettings().endSeconds, 4);
  assert.equal(editedDraft.trim.selectionStartSeconds, 1); assert.equal(editedDraft.trim.selectionEndSeconds, 4);
  assert.equal(editedDraft.file.size, 44 + 31200 * 2);
  assert.equal(editedDraft.transcriptRequired, true); assert.equal(editedDraft.transcriptConfirmed, false);
  const beforeUnconfirmed = voiceWrites.length;
  await t.saveVoice({ preventDefault() {} });
  assert.equal(voiceWrites.length, beforeUnconfirmed);
  assert.equal(document.activeElement, elements.get('reference-confirmed'));
  const confirmTranscript = () => { elements.get('reference-confirmed').checked = true; for (const callback of elements.get('reference-confirmed').listeners.change || []) callback(); };
  confirmTranscript(); assert.equal(editedDraft.transcriptConfirmed, true);
  referenceApi.changeSettings({ normalizeEnabled: false });
  assert.equal(editedDraft.transcriptConfirmed, true, 'Gain-only edits must not change spoken-word confirmation');
  elements.get('reference-text').value = 'This is the revised exact reference.';
  for (const callback of elements.get('reference-text').listeners.input || []) callback();
  assert.equal(editedDraft.transcriptConfirmed, false, 'Changing the claimed transcript invalidates the earlier acknowledgement');
  confirmTranscript();
  failVoiceSave = true; const preparedFile = editedDraft.file;
  await t.saveVoice({ preventDefault() {} });
  assert.equal(t.state.modal, editedDraft); assert.equal(editedDraft.file, preparedFile);
  assert.equal(editedDraft.transcriptConfirmed, true);
  const editPayload = voiceWrites.at(-1);
  assert.equal(editPayload.has('audio'), true); assert.equal(editPayload.has('original_audio'), false);
  assert.equal(editPayload.get('reference_edit_version'), '1');
  assert.equal(Number(editPayload.get('selection_start_seconds')), 1); assert.equal(Number(editPayload.get('selection_end_seconds')), 4);
  assert.equal(Number(editPayload.get('trim_start_seconds')), 1.85); assert.equal(Number(editPayload.get('trim_end_seconds')), 2.85);
  assert.equal(editPayload.get('normalize_enabled'), 'false'); assert.equal(Number(editPayload.get('normalization_gain_db')), 0);
  assert.equal(Number(editPayload.get('original_duration_seconds')), 6);
  await t.saveVoice({ preventDefault() {} }); assert.equal(t.state.modal, null);
  assert.equal(pcmHash(sourceSamples), sourceHash);
  passed('Reopened selections survive trim toggles, require transcript acknowledgement, preserve it for gain-only changes, and save metadata without replacing the original');

  t.openVoiceEditor(editedVoice); await t.loadReferenceEditor();
  referenceApi.changeSettings({ startSeconds: -1 });
  assert(t.state.modal.audioError); assert.equal(elements.get('voice-save').disabled, true);
  referenceApi.changeSettings({ startSeconds: 1 });
  assert.equal(t.state.modal.audioError, ''); assert.equal(elements.get('voice-save').disabled, false);
  referenceApi.changeSettings({ normalizeEnabled: false });
  const lastGoodPrepared = t.state.modal.file, writesBeforeSilent = voiceWrites.length;
  referenceApi.changeSettings({ startSeconds: 0, endSeconds: 1 });
  assert(t.state.modal.audioError); assert.equal(elements.get('voice-save').disabled, true);
  const processingError = t.state.modal.audioError;
  assert.equal(t.state.modal.file, lastGoodPrepared);
  referenceApi.changeSettings({ startSeconds: -1 });
  referenceApi.changeSettings({ startSeconds: 0 });
  assert.equal(t.state.modal.audioError, processingError, 'Fixing numeric syntax cannot erase an unresolved silence/processing error');
  assert.equal(elements.get('voice-save').disabled, true);
  await t.saveVoice({ preventDefault() {} }); assert.equal(voiceWrites.length, writesBeforeSilent);
  referenceApi.changeSettings({ startSeconds: 1, endSeconds: 4 });
  assert.equal(t.state.modal.audioError, ''); assert.equal(elements.get('voice-save').disabled, false);
  const previewPlayer = elements.get('reference-player'), selectionPlayer = elements.get('reference-selection-player');
  await previewPlayer.play(); assert.equal(previewPlayer.paused, false);
  await elements.get('reference-play-selection').listeners.click[0]();
  assert.equal(previewPlayer.paused, true); assert.equal(selectionPlayer.paused, false);
  const selectionUrl = selectionPlayer.src; assert(activeObjectUrls.has(selectionUrl));
  await previewPlayer.play(); assert.equal(selectionPlayer.paused, true);
  referenceApi.changeSettings({ endSeconds: 3.5 });
  assert(revokedUrls.includes(selectionUrl)); assert(!selectionPlayer.src, 'An obsolete selection URL must be removed from the player');
  assert.equal(selectionPlayer.hidden, true);
  t.closeVoiceEditor(true); t.openVoiceEditor(voice);
  assert.equal(referenceApi.getSettings(), null); assert.equal(t.state.modal.referenceSettings, null);
  assert.equal(t.state.modal.transcriptRequired, false);
  t.closeVoiceEditor(true);
  passed('Numeric selection recovery preserves unresolved processing errors; previews stop each other and changed or closed selections cannot replay stale audio');

  const pendingAudio = new Map();
  audioDecodeHandler = data => new Promise(resolve => pendingAudio.set(new Uint8Array(data)[0], resolve));
  t.openVoiceEditor(voice);
  const oldAudioJob = t.chooseAudio(new File([new Uint8Array([11])], 'first.wav'));
  await flush();
  const freshAudioJob = t.chooseAudio(new File([new Uint8Array([12])], 'second.wav'));
  await flush();
  pendingAudio.get(12)(decodedAudio(audioFixture(.3))); await freshAudioJob;
  const winningDraft = t.state.modal, winningHash = pcmHash(winningDraft.original), winningFile = winningDraft.file;
  pendingAudio.get(11)(decodedAudio(audioFixture(.1))); await oldAudioJob;
  assert.equal(t.state.modal, winningDraft); assert.equal(winningDraft.filename, 'second.wav');
  assert.equal(pcmHash(winningDraft.original), winningHash); assert.equal(winningDraft.file, winningFile);
  assert.equal(winningDraft.transcriptRequired, true); assert.equal(winningDraft.transcriptConfirmed, false);
  assert.equal(winningDraft.newSource, true); assert.equal(winningDraft.converting, false);
  confirmTranscript();
  await t.saveVoice({ preventDefault() {} });
  assert.equal(voiceWrites.at(-1).has('audio'), true); assert.equal(voiceWrites.at(-1).has('original_audio'), true);
  const originalWav = new DataView(await voiceWrites.at(-1).get('original_audio').arrayBuffer());
  assert.equal(originalWav.getUint32(40, true) / 2, 6 * 24000);
  assert.equal(voiceWrites.at(-1).get('reference_edit_version'), '1');
  t.openVoiceEditor(voice);
  const closingAudioJob = t.chooseAudio(new File([new Uint8Array([13])], 'closing.wav'));
  await flush(); t.closeVoiceEditor(true); t.openVoiceEditor(editedVoice);
  const nextDraft = t.state.modal;
  pendingAudio.get(13)(decodedAudio(audioFixture(.4))); await closingAudioJob;
  assert.equal(t.state.modal, nextDraft); assert.equal(nextDraft.original, null); assert.equal(nextDraft.file, null);
  assert.equal(nextDraft.newSource, false); assert.equal(referenceApi.getSettings(), null);
  t.closeVoiceEditor(true);
  t.openVoiceEditor(editedVoice);
  const oldSavedLoad = t.loadReferenceEditor(); await flush();
  const replacementDuringLoad = t.chooseAudio(new File([new Uint8Array([14])], 'replacement.wav')); await flush();
  pendingAudio.get(14)(decodedAudio(audioFixture(.35))); await replacementDuringLoad;
  const replacementDraft = t.state.modal, replacementHash = pcmHash(replacementDraft.original);
  pendingAudio.get(1)(decodedAudio(sourceSamples)); await oldSavedLoad;
  assert.equal(t.state.modal, replacementDraft); assert.equal(replacementDraft.filename, 'replacement.wav');
  assert.equal(replacementDraft.newSource, true); assert.equal(pcmHash(replacementDraft.original), replacementHash);
  assert.equal(referenceApi.getSettings().startSeconds, 0); assert.equal(referenceApi.getSettings().endSeconds, 6);
  assert.equal(replacementDraft.converting, false);
  t.closeVoiceEditor(true); audioDecodeHandler = null;
  assert.equal(activeObjectUrls.size, 0);
  passed('Out-of-order, closed, or superseded saved-audio decodes cannot replace the active draft; a newly selected source alone uploads the full original alongside its prepared WAV');

  const enhancementCheckStart = checks.length;
  t.state.historyQuery = ''; elements.get('history-search').value = '';
  const readyStatus = () => { status = { ...status, state: 'ready', request_id: '', can_cancel: false, cancel_requested: false }; t.state.status = status; };
  readyStatus();
  status.enhancement = { available: true, loaded: false, load_count: 0, model_id: 'reuse' }; t.state.status = status;
  t.applyDraft({ text: 'Optional enhancement test.', voice_id: voice.id, model_id: 'flash', seed: 17, speed: 1 });
  assert.equal(t.currentDraft().enhance_output, false); assert.equal(t.requestSettings().enhance_output, false);
  const toggleEnhancement = value => { elements.get('enhance-output').checked = value; for (const fn of elements.get('enhance-output').listeners.change) fn(); };
  const beforeEnhanceCalls = generatedRequests.length;
  const plainEnhancementPlanKey = t.planKey();
  toggleEnhancement(true);
  assert.notEqual(t.planKey(), plainEnhancementPlanKey, 'Enhancement limits require a separate server plan cache entry');
  assert.equal(t.readDraft().enhance_output, true); assert.equal(t.requestSettings().enhance_output, true);
  assert.equal(generatedRequests.length, beforeEnhanceCalls); assert.equal(enhancementRequests.length, 0);
  await t.loadPlan(t.planKey(), t.state.planRevision); assert.equal(planRequests.at(-1).enhance_output, true);
  const enhanceGeneration = t.generate(); await flush();
  const enhanceGenerationRequest = generatedRequests.at(-1);
  assert.equal(enhanceGenerationRequest.enhance_output, true); assert.equal(t.state.request.draft.enhance_output, true);
  toggleEnhancement(false); assert.equal(t.currentDraft().enhance_output, true);
  status = { ...status, state: 'loading_enhancement', request_id: enhanceGenerationRequest.request_id, can_cancel: true }; await t.refreshStatus();
  assert.equal(elements.get('enhance-output').disabled, true); assert.equal(elements.get('generate-button').disabled, true);
  assert.equal(elements.get('generate-label').textContent, sandbox.window.StudioI18n.t('enhance.loading'));
  assert.equal(editBridge.getStatus().state, 'generating');
  const rawGenerated = { id: 'enhance-raw', voice_id: voice.id, voice_name: voice.name, text: enhanceGenerationRequest.text, model_id: 'flash', seed: 17,
    enhance_output: false, enhanced: false, duration_seconds: 4, audio_url: '/api/audio/outputs/enhance-raw', created_at: new Date().toISOString() };
  const enhancedGenerated = { ...rawGenerated, id: 'enhance-generated', enhance_output: true, enhanced: true, source_id: rawGenerated.id, parent_id: rawGenerated.id,
    original_audio_url: rawGenerated.audio_url, audio_url: '/api/audio/outputs/enhance-generated', request_id: enhanceGenerationRequest.request_id };
  history = [enhancedGenerated, rawGenerated, ...history]; readyStatus(); generationResolve(enhancedGenerated); await enhanceGeneration;
  assert.equal(t.state.activeResultId, enhancedGenerated.id);
  assert.equal(elements.get('enhance-result').hidden, true); assert.equal(elements.get('enhance-result').disabled, true);
  const duplicateRequests = enhancementRequests.length; await t.enhanceExistingResult(enhancedGenerated); assert.equal(enhancementRequests.length, duplicateRequests);
  assert.equal(elements.get('result-enhancement-comparison').hidden, false);
  assert.equal(new URL(elements.get('result-before-player').src).pathname, rawGenerated.audio_url);
  assert(elements.get('history-list').innerHTML.includes(sandbox.window.StudioI18n.t('enhance.badge')));
  t.reuseResult(enhancedGenerated); assert.equal(t.currentDraft().enhance_output, true);
  t.reuseResult(rawGenerated); assert.equal(t.currentDraft().enhance_output, false);
  elements.get('toast-action').listeners.click[0](); assert.equal(t.currentDraft().enhance_output, true);
  passed('Speech Enhancement defaults off, persists explicit intent, locks the captured request through model loading and restores actual history settings with A/B provenance');

  readyStatus(); toggleEnhancement(true); await t.loadPlan(t.planKey(), t.state.planRevision);
  const disconnectedGeneration = t.generate(); await flush();
  const disconnectedId = generatedRequests.at(-1).request_id;
  const networkRaw = { ...rawGenerated, id: 'network-loss-raw', request_id: disconnectedId };
  history = [networkRaw, ...history];
  status = { ...status, state: 'enhancing', request_id: disconnectedId, can_cancel: true };
  generationReject(new TypeError('fetch failed')); await disconnectedGeneration;
  assert.equal(t.state.recovering, true); assert.equal(t.state.request.id, disconnectedId);
  assert.equal(elements.get('cancel-row').hidden, false); assert.equal(elements.get('cancel-generation').disabled, false);
  const networkEnhanced = { ...enhancedGenerated, id: 'network-loss-enhanced', source_id: networkRaw.id, parent_id: networkRaw.id,
    original_audio_url: networkRaw.audio_url, request_id: disconnectedId };
  history = [networkRaw, networkEnhanced, ...history.filter(item => item.id !== networkRaw.id)];
  readyStatus(); await t.refreshStatus();
  assert.equal(t.state.activeResultId, networkEnhanced.id); assert.equal(t.state.recovering, false); assert.equal(t.state.request, null);
  const reloadId = 'b'.repeat(32), reloadRaw = { ...rawGenerated, id: 'reloaded-raw-only', request_id: reloadId };
  history = [reloadRaw, ...history];
  t.state.request = { id: reloadId, draft: { enhance_output: true }, cancelled: false }; t.state.recovering = true;
  readyStatus(); await t.refreshStatus();
  assert.equal(t.state.activeResultId, reloadRaw.id); assert.equal(t.state.request, null);
  assert.equal(elements.get('generation-error').textContent, sandbox.window.StudioI18n.t('enhance.rawSaved'));
  passed('Connection-loss recovery keeps cancellation active while RE-USE runs, prefers the enhanced result over raw history order, and labels raw-only reload recovery incomplete');

  for (const cancelledWithRaw of [false, true]) {
    readyStatus(); toggleEnhancement(true); await t.loadPlan(t.planKey(), t.state.planRevision);
    const job = t.generate(); await flush();
    const request = generatedRequests.at(-1), raw = { ...rawGenerated, id: cancelledWithRaw ? 'cancelled-enhance-raw' : 'failed-enhance-raw', request_id: request.request_id, enhance_output_requested: true };
    history = [raw, ...history];
    if (cancelledWithRaw) await t.cancelGeneration();
    readyStatus(); generationResolve({ raw_result: raw, enhancement_failed: true, request_id: request.request_id,
      ...(cancelledWithRaw ? { cancelled: true } : { error: 'Controlled enhancement failure' }) }, cancelledWithRaw ? 200 : 500);
    await job;
    assert.equal(t.state.activeResultId, raw.id); assert.equal(t.state.request, null); assert.equal(t.state.generating, false);
    assert.equal(elements.get('result-enhancement-comparison').hidden, true);
    assert.equal(elements.get('generation-error').textContent, sandbox.window.StudioI18n.t('enhance.rawSaved'));
    assert.equal(elements.get('enhance-result').disabled, false);
  }
  passed('Both failed and cancelled post-generation enhancement retain the completed raw recording, explicitly label it unenhanced and permit retry');

  readyStatus(); const beforeSource = JSON.stringify(rawGenerated), beforeDraft = JSON.stringify(t.currentDraft());
  const existingJob = t.enhanceExistingResult(rawGenerated); await flush();
  assert.equal(enhancementRequests.at(-1).source_id, rawGenerated.id);
  assert.equal(JSON.stringify(t.currentDraft()), beforeDraft); assert.equal(t.state.request.kind, 'enhancement');
  const enhancedExisting = { ...enhancedGenerated, id: 'enhance-existing', request_id: enhancementRequests.at(-1).request_id };
  history = [enhancedExisting, ...history]; readyStatus(); enhancementResolve(enhancedExisting); await existingJob;
  assert.equal(JSON.stringify(rawGenerated), beforeSource); assert.equal(t.state.activeResultId, enhancedExisting.id);
  const comparisonNode = elements.get('result-before-player'); comparisonNode.currentTime = 1.1;
  for (const locale of ['en', 'ko', 'zh', 'ja']) {
    sandbox.window.StudioI18n.setLocale(locale);
    assert.equal(elements.get('result-before-player'), comparisonNode); assert.equal(comparisonNode.currentTime, 1.1);
    assert.equal(elements.get('result-before-label').textContent, sandbox.window.StudioI18n.t('enhance.before'));
    assert.equal(elements.get('result-after-label').textContent, sandbox.window.StudioI18n.t('enhance.after'));
  }
  const failedExistingJob = t.enhanceExistingResult(rawGenerated); await flush();
  readyStatus(); enhancementResolve({ error: 'Controlled standalone error', raw_result: rawGenerated, enhancement_failed: true }, 500); await failedExistingJob;
  assert.equal(t.state.activeResultId, rawGenerated.id); assert.equal(JSON.stringify(rawGenerated), beforeSource);
  passed('Enhancing existing history uses an immutable source and new result, keeps composer settings, supports localized A/B playback and recovers the source after failure');

  status.enhancement = { available: false, loaded: false }; t.state.status = status;
  t.applyDraft({ ...t.currentDraft(), enhance_output: true });
  assert.equal(t.state.plan.state, 'invalid'); assert.equal(t.currentDraft().enhance_output, true);
  assert.equal(elements.get('enhance-output').disabled, false, 'An unavailable saved option must remain switchable off');
  assert.equal(elements.get('generate-button').disabled, true);
  const beforeUnavailable = enhancementRequests.length; await t.enhanceExistingResult(rawGenerated); assert.equal(enhancementRequests.length, beforeUnavailable);
  toggleEnhancement(false); assert.equal(t.enhancementIssue(), '');
  status.enhancement = { available: true, loaded: true, load_count: 1, model_id: 'reuse' }; readyStatus();
  passed('Unavailable enhancement never falls back silently; users can disable a persisted unavailable option and continue normal synthesis');

  audioDecodeHandler = async () => decodedAudio(sourceSamples);
  const referenceResponse = (id, count) => ({ id, audio_url: '/api/audio/enhancement/' + id + '.wav', input_audio_url: '/api/audio/enhancement/' + id + '-input.wav',
    samples: count, sample_rate: 24000, duration_seconds: count / 24000, enhancement: { model_id: 'reuse', checkpoint_sha256: 'trusted-by-server' } });
  async function completeReferencePreview(id) {
    const active = t.enhanceReference(); await flush();
    const prepared = referenceEnhancementRequests.at(-1).get('audio');
    const bytes = await prepared.arrayBuffer(), count = new DataView(bytes).getUint32(40, true) / 2;
    enhancementWave = bytes.slice(0);
    new DataView(enhancementWave).setInt16(44 + 14000 * 2, 123, true); // Distinct returned server WAV, preserved byte-for-byte.
    readyStatus(); referenceEnhancementResolve(referenceResponse(id, count)); await active;
    return Buffer.from(enhancementWave);
  }
  t.openVoiceEditor(editedVoice); await t.loadReferenceEditor();
  const referenceDraft = t.state.modal, originalText = elements.get('reference-text').value;
  const encodedPreview = await completeReferencePreview('reference-enhanced-one');
  assert.equal(referenceDraft.audioDirty, false); assert.equal(referenceDraft.file, null); assert.equal(referenceDraft.promptEnhancementApplied, false);
  assert.equal(elements.get('reference-text').value, originalText); assert.equal(elements.get('reference-enhancement-comparison').hidden, false);
  for (const locale of ['en', 'ko', 'zh', 'ja']) {
    sandbox.window.StudioI18n.setLocale(locale);
    assert.equal(referenceDraft.enhancementPreview.id, 'reference-enhanced-one'); assert.equal(referenceDraft.audioDirty, false);
    assert.equal(elements.get('reference-text').value, originalText);
  }
  t.applyReferenceEnhancement();
  assert.equal(referenceDraft.promptEnhancementApplied, true); assert.equal(referenceDraft.transcriptConfirmed, false);
  assert.equal(elements.get('reference-enhance').disabled, true);
  const duplicatePromptRequests = referenceEnhancementRequests.length; await t.enhanceReference(); assert.equal(referenceEnhancementRequests.length, duplicatePromptRequests);
  const beforePromptConfirmation = voiceWrites.length; await t.saveVoice({ preventDefault() {} }); assert.equal(voiceWrites.length, beforePromptConfirmation);
  confirmTranscript(); failVoiceSave = true; await t.saveVoice({ preventDefault() {} });
  assert.equal(t.state.modal, referenceDraft); assert.equal(referenceDraft.enhancementPreview.id, 'reference-enhanced-one');
  const enhancedForm = voiceWrites.at(-1);
  assert.equal(enhancedForm.get('prompt_enhancement_id'), 'reference-enhanced-one'); assert.equal(enhancedForm.has('original_audio'), false);
  assert.equal(Buffer.compare(Buffer.from(await enhancedForm.get('audio').arrayBuffer()), encodedPreview), 0);
  assert.equal(enhancedForm.get('reference_text'), originalText);
  assert.equal(Number(enhancedForm.get('selection_start_seconds')), 1); assert.equal(Number(enhancedForm.get('selection_end_seconds')), 4);
  await t.saveVoice({ preventDefault() {} }); assert.equal(t.state.modal, null);
  assert.equal(pcmHash(sourceSamples), sourceHash);
  passed('Prompt Enhancement previews without audio writes or transcript rewriting, applies explicitly, requires confirmation, and retries with exact token-bound WAV bytes while preserving the original');

  for (const [id, change] of [
    ['range', () => referenceApi.changeSettings({ endSeconds: 3.5 })],
    ['trim', () => { elements.get('trim-silence').checked = true; t.toggleTrim(); }],
    ['gain', () => referenceApi.changeSettings({ normalizeEnabled: false })],
  ]) {
    t.openVoiceEditor(editedVoice); await t.loadReferenceEditor(); await completeReferencePreview('invalidate-' + id);
    t.applyReferenceEnhancement(); confirmTranscript(); change();
    assert.equal(t.state.modal.enhancementPreview, null); assert.equal(t.state.modal.promptEnhancementApplied, false);
    assert.equal(elements.get('reference-enhancement-comparison').hidden, true);
    assert.equal(elements.get('reference-enhancement-status').textContent, sandbox.window.StudioI18n.t('enhance.stale'));
    confirmTranscript(); await t.saveVoice({ preventDefault() {} });
    assert.equal(voiceWrites.at(-1).has('prompt_enhancement_id'), false); assert.equal(voiceWrites.at(-1).has('original_audio'), false);
  }
  const savedEnhancedVoice = { ...editedVoice, prompt_enhancement: { enabled: true, id: 'saved-server-token' } };
  t.openVoiceEditor(savedEnhancedVoice); await t.loadReferenceEditor();
  assert.equal(elements.get('reference-enhancement-badge').hidden, false); assert.equal(t.state.modal.audioDirty, false);
  elements.get('voice-name').value = 'Enhanced metadata rename'; await t.saveVoice({ preventDefault() {} });
  assert.equal(voiceWrites.at(-1).has('audio'), false); assert.equal(voiceWrites.at(-1).has('prompt_enhancement_id'), false);
  passed('Range, trim or gain changes invalidate enhanced previews with a reapply hint; saved enhanced profiles retain provenance on metadata-only saves');

  t.openVoiceEditor(editedVoice); await t.loadReferenceEditor();
  const cancelledDraft = t.state.modal, originalSavedUrl = elements.get('reference-player').src;
  const referenceCancelJob = t.enhanceReference(); await flush();
  const referenceCancelId = referenceEnhancementRequests.at(-1).get('request_id');
  assert.equal(elements.get('voice-save').disabled, true); assert.equal(elements.get('voice-audio').disabled, true);
  assert.equal(elements.get('generate-button').disabled, true); assert.equal(referenceCancelId, t.state.enhancementJob.id);
  t.closeVoiceEditor(); assert.equal(t.state.modal, cancelledDraft); assert.equal(elements.get('voice-discard-confirmation').hidden, false);
  await t.cancelReferenceEnhancement(); assert.equal(cancelRequests.at(-1).request_id, referenceCancelId);
  readyStatus(); referenceEnhancementResolve({ cancelled: true }); await referenceCancelJob;
  assert.equal(cancelledDraft.enhancementPreview, null); assert.equal(cancelledDraft.audioDirty, false);
  assert.equal(elements.get('reference-player').src, originalSavedUrl); assert.equal(t.state.enhancementJob, null);
  const referenceFailJob = t.enhanceReference(); await flush();
  readyStatus(); referenceEnhancementResolve({ error: 'Controlled prompt enhancement failure' }, 500); await referenceFailJob;
  assert(cancelledDraft.enhancementError); assert.equal(cancelledDraft.audioDirty, false);
  assert.equal(elements.get('reference-enhance').textContent, sandbox.window.StudioI18n.t('enhance.retry'));
  await completeReferencePreview('retry-after-error'); assert.equal(cancelledDraft.enhancementError, '');
  t.discardReferenceEnhancement(); assert.equal(cancelledDraft.enhancementPreview, null); assert.equal(cancelledDraft.audioDirty, false);
  const obsoleteReferenceJob = t.enhanceReference(); await flush();
  t.closeVoiceEditor(true); t.openVoiceEditor(voice); const afterClosedDraft = t.state.modal;
  readyStatus(); referenceEnhancementResolve(referenceResponse('obsolete-preview', 72000)); await obsoleteReferenceJob;
  assert.equal(t.state.modal, afterClosedDraft); assert.equal(afterClosedDraft.enhancementPreview, undefined);
  assert.equal(afterClosedDraft.audioDirty, false); assert.equal(t.state.enhancementJob, null);
  assert.equal(elements.get('voice-save').disabled, false); assert.equal(elements.get('voice-audio').disabled, false);
  assert.equal(elements.get('reference-edit-open').disabled, false);
  t.closeVoiceEditor(true);
  passed('Reference enhancement shares the generation lock, cancels by exact request ID, retains base audio after failures, retries safely and ignores results for a closed draft');

  t.openVoiceEditor(editedVoice); await t.loadReferenceEditor(); await completeReferencePreview('replace-source'); t.applyReferenceEnhancement();
  await t.chooseAudio(new File([new Uint8Array([20])], 'entirely-new.wav'));
  assert.equal(t.state.modal.promptEnhancementApplied, false); assert.equal(t.state.modal.enhancementPreview, null);
  assert.equal(elements.get('reference-enhancement-status').textContent, sandbox.window.StudioI18n.t('enhance.stale'));
  assert.equal(t.state.modal.newSource, true); assert.equal(t.state.modal.transcriptConfirmed, false);
  confirmTranscript(); await t.saveVoice({ preventDefault() {} });
  assert.equal(voiceWrites.at(-1).has('prompt_enhancement_id'), false); assert.equal(voiceWrites.at(-1).has('original_audio'), true);
  audioDecodeHandler = null; assert.equal(activeObjectUrls.size, 0);
  passed('Replacing the source invalidates applied enhancement and its token, requires new transcript confirmation and preserves the newly uploaded original');

  const report = {
    created_at: new Date().toISOString(), node_version: process.version,
    scope: 'Actual frontend and reference editor source executed with a mocked DOM, deterministic API, controlled timers and predecoded 24 kHz float samples. Real browser rendering, WAV/MP3 decoding, resampling quality, audio hardware and native/GPU behavior are not exercised.',
    live_server_used: false, browser_used: false, gpu_used: false,
    sources: Object.fromEntries(['index.html', 'app.js', 'style.css', 'reference-editor.js', 'reference-editor.css', ...catalogNames].map(name => [name, {
      path: path.join(webRoot, name), sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(webRoot, name))).digest('hex'),
    }])),
    passed: checks.length, failed: 0, checks,
  };
  const destination = path.join(__dirname, 'frontend_ux_validation.json');
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
  const enhancementReport = { ...report, scope: report.scope + ' Enhancement responses, exact returned WAV bytes, cancellation and failures are controlled fixtures; no RE-USE model quality or native enhancement behavior is tested.',
    passed: checks.length - enhancementCheckStart, checks: checks.slice(enhancementCheckStart) };
  fs.writeFileSync(path.join(__dirname, 'frontend_enhancement_validation.json'), JSON.stringify(enhancementReport, null, 2) + '\n');
  console.log(JSON.stringify({ report: destination, passed: report.passed, failed: report.failed }));
}

const watchdog = setTimeout(() => { console.error('Frontend test did not settle; an async fixture is unresolved.'); process.exit(1); }, 10000);
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
