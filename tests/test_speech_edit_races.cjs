// Run: node tests/test_speech_edit_races.cjs
// Exercises actual editor functions with controlled promises/timers; no server or GPU.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const sourcePath = path.resolve(__dirname, '../web/speech-edit.js');
const source = fs.readFileSync(sourcePath, 'utf8');
function extract(start, end) {
  const begin = source.indexOf(start), finish = source.indexOf(end, begin);
  assert(begin >= 0 && finish > begin, 'Update harness for changed function boundaries: ' + start);
  return source.slice(begin, finish);
}
const sections = [
  ['  function sampleRange(', '  function segmentRanges('],
  ['  function close()', '  function refreshVoices('],
  ['  async function stepVersion(', '  function updatePlayhead('],
  ['  function select(', '  function pointerMove('],
  ['  async function cancelJob(', '  function refreshLocale('],
];
const functions = sections.map(([start, end]) => extract(start, end)).join('\n');
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function editor(item = { id: 'original' }) {
  return { item, versions: [item, { id: 'edited' }], version: 0, wave: { duration: 4, samples: new Float32Array(96000) }, start: .5, end: 1.5, busy: false, requestId: null };
}
function fixture() {
  const errors = [], applied = [], intervals = new Map(), clears = [], playCalls = [];
  let nextTimer = 0, plans = 0;
  const elements = new Map([
    ['edit-cancel-job', { disabled: false }], ['edit-start', { value: '.25' }], ['edit-end', { value: '1.25' }],
    ['edit-wave-track', { getBoundingClientRect: () => ({ left: 0, width: 400 }), setPointerCapture() {} }],
  ]);
  const makeAudio = () => ({ paused: false, pauseCount: 0, currentTime: 0,
    pause() { this.paused = true; this.pauseCount++; }, removeAttribute() {}, load() {},
    play() { const pending = deferred(); playCalls.push(pending); this.paused = false; return pending.promise; },
  });
  const context = {
    state: editor(), loadRevision: 0, planRevision: 0, playRevision: 0, planTimer: null, playTimer: null, recoveryTimer: null, pendingJob: null,
    dialog: { open: true, close() { this.open = false; } }, audio: makeAudio(), originalAudio: makeAudio(),
    $: id => elements.get(id), setError: message => errors.push(message), t: key => key,
    updateRange() {}, paintSelection() {}, updatePlayhead() {}, schedulePlan() { plans++; },
    Math, Number, Float32Array, clearTimeout() {}, storePendingEdit() {}, scheduleRecovery() {}, rememberSession() {},
    setInterval(callback) { intervals.set(++nextTimer, callback); return nextTimer; },
    clearInterval(id) { clears.push(id); intervals.delete(id); },
    hooks: { onResult: async item => applied.push(item.id), readableError: error => error.message },
  };
  context.busy = () => !!context.state?.busy;
  context.loadItem = async item => { context.loadRevision++; context.state.item = item; };
  vm.createContext(context); vm.runInContext(functions, context, { filename: sourcePath });
  return { context, errors, applied, intervals, clears, playCalls, elements, plans: () => plans };
}
const checks = [];
async function check(name, fn) { await fn(); checks.push({ name, passed: true }); }
async function main() {
  await check('Undo awaiting audio load remains safe when the dialog closes', async () => {
    const f = fixture(), pending = deferred(), c = f.context;
    c.loadItem = item => { c.loadRevision++; c.state.item = item; return pending.promise; };
    const work = c.stepVersion(1); c.close(); pending.resolve(); await work;
    assert.equal(c.state, null); assert.equal(c.dialog.open, false); assert.deepEqual(f.applied, []);
  });
  await check('Late Undo cannot select a recording opened in a different editor session', async () => {
    const f = fixture(), pending = deferred(), c = f.context;
    c.loadItem = item => { c.loadRevision++; c.state.item = item; return pending.promise; };
    const work = c.stepVersion(1); c.close(); c.state = editor({ id: 'another-recording' }); c.dialog.open = true;
    pending.resolve(); await work; assert.deepEqual(f.applied, []); assert.equal(c.state.item.id, 'another-recording');
  });
  await check('Undo ignores superseded and failed audio loads but accepts its successful current version', async () => {
    for (const mode of ['superseded', 'failed', 'success']) {
      const f = fixture(), pending = deferred(), c = f.context;
      c.loadItem = item => { c.loadRevision++; c.state.item = item; return pending.promise; };
      const work = c.stepVersion(1);
      if (mode === 'superseded') { c.loadRevision++; c.state.item = { id: 'newer' }; }
      if (mode === 'failed') c.state.wave = null;
      pending.resolve(); await work;
      assert.deepEqual(f.applied, mode === 'success' ? ['edited'] : []);
    }
  });
  await check('Current Undo callback errors remain actionable without unhandled rejections', async () => {
    const f = fixture(); f.context.hooks.onResult = async () => { throw new Error('History failed'); };
    await f.context.stepVersion(1); assert.deepEqual(f.errors, ['History failed']);
  });
  await check('Late cancellation errors cannot alter a new editor session or a newer request', async () => {
    for (const reopen of [true, false]) {
      const f = fixture(), pending = deferred(), c = f.context;
      c.state.busy = true; c.state.requestId = 'old'; c.hooks.api = () => pending.promise;
      const work = c.cancelJob();
      if (reopen) c.state = editor({ id: 'new-session' });
      c.state.requestId = 'new'; c.state.busy = true; f.elements.get('edit-cancel-job').disabled = true;
      pending.reject(new Error('Old request already finished')); await work;
      assert.deepEqual(f.errors, []); assert.equal(f.elements.get('edit-cancel-job').disabled, true);
    }
  });
  await check('An active cancellation failure allows retry; an accepted request stays disabled', async () => {
    for (const fails of [true, false]) {
      const f = fixture(), pending = deferred(), c = f.context;
      c.state.busy = true; c.state.requestId = 'current'; let body;
      c.hooks.api = (url, options) => { body = options.json; return pending.promise; };
      const work = c.cancelJob(); assert.equal(body.request_id, 'current');
      if (fails) pending.reject(new Error('Network unavailable')); else pending.resolve({ cancelled: true });
      await work; assert.equal(f.elements.get('edit-cancel-job').disabled, !fails);
      assert.deepEqual(f.errors, fails ? ['Network unavailable'] : []);
    }
  });
  await check('Late playback resolve or rejection after close cannot install timers or show stale errors', async () => {
    for (const rejects of [false, true]) {
      const f = fixture(), c = f.context; c.playSelection(); const old = f.playCalls[0];
      c.close(); c.state = editor({ id: 'new-session' }); c.dialog.open = true;
      if (rejects) old.reject(new Error('Old playback aborted')); else old.resolve();
      await flush(); assert.equal(f.intervals.size, 0); assert.deepEqual(f.errors, []);
    }
  });
  await check('A newer playback request owns the only timer and stops at its captured selection end', async () => {
    const f = fixture(), c = f.context;
    c.playSelection(); const old = f.playCalls[0];
    c.state.start = 2; c.state.end = 3; c.playSelection(); const current = f.playCalls[1];
    current.resolve(); await flush(); old.resolve(); await flush(); assert.equal(f.intervals.size, 1);
    c.state.end = 3.8; c.audio.currentTime = 3;
    [...f.intervals.values()][0](); assert.equal(c.audio.paused, true); assert.equal(f.intervals.size, 0);
  });
  await check('Selecting, typing a range, or dragging stops current preview audio and its boundary timer', async () => {
    for (const operation of ['select', 'inputRange', 'pointerDown']) {
      const f = fixture(), c = f.context;
      c.playSelection(); f.playCalls[0].resolve(); await flush(); assert.equal(f.intervals.size, 1);
      const pauses = c.audio.pauseCount;
      if (operation === 'select') c.select(1, 2);
      else if (operation === 'inputRange') c.inputRange();
      else c.pointerDown({ button: 0, pointerId: 1, clientX: 100, preventDefault() {}, target: { closest: () => null } });
      assert.equal(f.intervals.size, 0); assert(c.audio.pauseCount > pauses); assert.equal(c.audio.paused, true);
    }
  });
  const report = { created_at: new Date().toISOString(), node_version: process.version,
    scope: 'Actual Speech Edit async ownership and playback functions executed with controlled promises and mocked media/DOM. No browser, server, audio device, or GPU was used.',
    source: sourcePath, source_sha256: crypto.createHash('sha256').update(source).digest('hex'), passed: checks.length, failed: 0, checks };
  const destination = path.join(__dirname, 'speech_edit_races_validation.json');
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: destination, passed: checks.length, failed: 0 }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
