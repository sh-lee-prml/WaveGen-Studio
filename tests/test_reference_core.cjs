// Executes the shipped reference editor's pure audio processing with the real trim function.
// No live server, browser, audio hardware, GPU, model, or media decoder is used.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../web');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const editor = fs.readFileSync(path.join(root, 'reference-editor.js'), 'utf8');
const catalogs = Array.from(html.matchAll(/<script\b[^>]*src="\/(i18n(?:-[\w-]+)?\.js)"/g), m => m[1]);
const nodes = new Map(), changes = [], invalidMessages = [], urls = new Set();
const canvasCalls = [];
class Element {
  constructor(id) { this.id = id; this.listeners = {}; this.attributes = {}; this.hidden = false; this.disabled = false; this.value = ''; this.checked = false; }
  set innerHTML(value) { this.html = value; for (const match of value.matchAll(/id="([^"]+)"/g)) nodes.set(match[1], new Element(match[1])); }
  querySelectorAll() { return []; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'src') delete this.src; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type, values = {}) { return Promise.all((this.listeners[type] || []).map(fn => fn({ target: this, preventDefault() {}, ...values }))); }
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  load() {}
  getBoundingClientRect() { return { left: 0, width: 600, height: 108 }; }
  getContext() { return Object.fromEntries(['scale','clearRect','fillRect','beginPath','moveTo','lineTo','stroke'].map(name => [name, (...args) => canvasCalls.push([name, ...args])])); }
}
nodes.set('reference-editor', new Element('reference-editor'));
const context = { window: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} },
  document: { getElementById: id => nodes.get(id), documentElement: { lang: 'en' } }, Float32Array, Float64Array, Uint8Array,
  URL: { createObjectURL: () => { const url = 'blob:test-' + (urls.size + 1); urls.add(url); return url; }, revokeObjectURL: url => urls.delete(url) },
  DataView, ArrayBuffer, Blob, Math, Number, Error, console };
vm.createContext(context);
for (const file of catalogs) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
context.t = context.window.StudioI18n.t;
const constantStart = app.indexOf('  const SAMPLE_RATE =');
const constantEnd = app.indexOf('  const icons =');
const trimStart = app.indexOf('  function trimSamples(');
const trimEnd = app.indexOf('  function encodePcmWav(', trimStart);
assert(constantStart >= 0 && constantEnd > constantStart && trimStart >= 0 && trimEnd > trimStart);
vm.runInContext(app.slice(constantStart, constantEnd) + '\n' + app.slice(trimStart, trimEnd), context);
vm.runInContext(editor, context, { filename: 'reference-editor.js' });
const processAudio = context.window.StudioReferenceEditor.processAudio;
assert.equal(typeof processAudio, 'function');
const rate = 24000;
const checks = [];
const hash = a => crypto.createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex');
const near = (a, b, tolerance = 1e-6) => assert(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);
const mark = (name, data = {}) => checks.push({ name, passed: true, ...data });
function tone(seconds = 6, amplitude = .2) {
  const result = new Float32Array(Math.round(seconds * rate));
  for (let i = 2 * rate; i < 3 * rate; i++) result[i] = amplitude * Math.sin(2 * Math.PI * 220 * i / rate);
  return result;
}
const original = tone(), originalHash = hash(original);
const settings = { startSeconds: 0, endSeconds: original.length / rate, trimEnabled: false, normalizeEnabled: false };
const run = (patch = {}, source = original) => processAudio(source, { ...settings, ...patch }, context.trimSamples, rate);

const full = run();
assert.equal(hash(full.samples), originalHash);
assert.notEqual(full.samples, original, 'Returned editable samples must not alias the immutable source');
near(full.normalizationGainDb, 0);
near(full.originalSeconds, 6);
mark('Disabled processing copies the original samples exactly without aliasing');

const start = 1.50003, end = 3.50002;
const selected = run({ startSeconds: start, endSeconds: end });
const first = Math.round(start * rate), last = Math.round(end * rate);
assert.equal(selected.samples.length, last - first);
assert.equal(hash(selected.samples), hash(original.slice(first, last)));
near(selected.selectionStartSeconds, first / rate);
near(selected.selectionEndSeconds, last / rate);
near(selected.startSeconds, first / rate);
near(selected.endSeconds, 6 - last / rate);
assert.equal(hash(original), originalHash);
mark('Range selection rounds to the original 24 kHz sample clock and preserves the exact selected PCM', { first_sample: first, end_sample_exclusive: last });

const trimmed = run({ startSeconds: 1, endSeconds: 4, trimEnabled: true });
assert.equal(trimmed.samples.length, 31200);
near(trimmed.startSeconds, 1.85); near(trimmed.endSeconds, 2.85);
near(trimmed.selectionStartSeconds, 1); near(trimmed.selectionEndSeconds, 4);
mark('Selection and edge trimming report original-relative removal and retain 150 ms margins');

const separated = new Float32Array(8 * rate);
for (let i = 2 * rate; i < 3 * rate; i++) separated[i] = .2 * Math.sin(2 * Math.PI * 220 * i / rate);
for (let i = 5 * rate; i < 6 * rate; i++) separated[i] = .2 * Math.sin(2 * Math.PI * 220 * i / rate);
const internal = run({ endSeconds: 8, trimEnabled: true }, separated);
assert.equal(internal.samples.length, 103200);
assert(internal.samples.slice(Math.round((3 - 1.85) * rate), Math.round((5 - 1.85) * rate)).every(v => v === 0));
mark('Trimming preserves internal pauses instead of joining unrelated speech');

const normalized = run({ normalizeEnabled: true });
const target = 10 ** (-3 / 20);
near(normalized.peakAfter, target, 1e-6);
near(normalized.normalizationGainDb, 20 * Math.log10(target / .2), 1e-5);
assert.equal(normalized.clippingCount, 0);
const quieter = tone(6, .001), quietHash = hash(quieter);
const boosted = run({ normalizeEnabled: true }, quieter);
near(boosted.normalizationGainDb, 12);
near(boosted.peakAfter, .001 * 10 ** (12 / 20), 1e-7);
assert.equal(hash(quieter), quietHash);
mark('Normalization targets -3 dBFS but caps amplification of quiet speech at +12 dB', { target_peak: target });

const hot = tone(6, 1.5), hotHash = hash(hot);
const attenuated = run({ normalizeEnabled: true }, hot);
assert(attenuated.normalizationGainDb < 0);
assert(attenuated.peakBefore > 1);
near(attenuated.peakAfter, target, 1e-6);
assert(attenuated.clippingCount > 0, 'Clipping diagnostic records already-hot source samples even after attenuation');
assert.equal(hash(hot), hotHash);
assert(attenuated.samples.every(Number.isFinite));
mark('Over-full-scale finite input is attenuated safely without mutating its original waveform');

const retrimmed = run({ startSeconds: 1, endSeconds: 4, trimEnabled: true });
assert.equal(hash(retrimmed.samples), hash(trimmed.samples));
const restored = run();
assert.equal(hash(restored.samples), originalHash);
const renormalized = run({ normalizeEnabled: true });
assert.equal(hash(renormalized.samples), hash(normalized.samples));
assert.equal(hash(original), originalHash);
mark('Range, trim and normalization toggles always recompute from the immutable original with no cumulative loss');

for (const invalid of [
  { startSeconds: 3, endSeconds: 2 }, { startSeconds: 2, endSeconds: 2.049 },
  { startSeconds: NaN }, { endSeconds: Infinity }, { startSeconds: -1 }, { endSeconds: 6.1 },
]) assert.throws(() => run(invalid), error => error.name === 'Error' && error.name !== 'ReferenceError');
assert.throws(() => run({ endSeconds: 1 }, new Float32Array(rate)), error => error.name === 'Error');
const nonfinite = original.slice(); nonfinite[50000] = NaN;
assert.throws(() => run({}, nonfinite), error => error.name === 'Error');
assert.throws(() => run({ normalizeEnabled: true }, tone(6, 1e9)), error => error.name === 'Error');
mark('Invalid or too-short selections and silent source fail before producing a saved audio result');

const normalizedTrimHash = hash(run({ trimEnabled: true, normalizeEnabled: true }).samples);
for (const locale of ['en', 'ko', 'zh', 'ja']) {
  context.window.StudioI18n.setLocale(locale);
  const value = run({ trimEnabled: true, normalizeEnabled: true });
  assert.equal(hash(value.samples), normalizedTrimHash);
  assert.equal(hash(original), originalHash);
}
mark('Four display languages leave audio samples and immutable input unchanged');

const api = context.window.StudioReferenceEditor;
const history = api.createHistory(settings), initial = history.current;
initial.startSeconds = 99;
assert.equal(history.current.startSeconds, 0);
assert.equal(history.commit({ ...settings }), false);
history.commit({ ...settings, startSeconds: 1 });
history.commit({ ...settings, startSeconds: 2 });
assert.equal(history.undo().startSeconds, 1);
assert.equal(history.undo().startSeconds, 0);
assert.equal(history.redo().startSeconds, 1);
history.commit({ ...settings, startSeconds: 1.5 });
assert.equal(history.redo().startSeconds, 1.5);
assert.equal(history.length, 3);
for (let i = 0; i < 80; i++) history.commit({ ...settings, startSeconds: i / 100 });
assert.equal(history.length, 60);
mark('Undo and redo copy settings, ignore duplicate commits, discard branched redo and bound the undo history');

api.init({ t: context.t, encodePcmWav: a => new Blob([a]),
  onChange: (value, info) => changes.push({ value, info }), onInvalid: message => invalidMessages.push(message) });
api.setSource({ original, settings });
assert.equal(changes.length, 0);
assert.equal(nodes.get('reference-undo').disabled, true);
api.changeSettings({ startSeconds: 1 });
assert.equal(changes.at(-1).info.wordsMayChange, true);
assert.equal(api.getSettings().startSeconds, 1);
api.changeSettings({ normalizeEnabled: true });
assert.equal(changes.at(-1).info.wordsMayChange, false);
nodes.get('reference-undo').fire('click');
assert.equal(api.getSettings().normalizeEnabled, false);
nodes.get('reference-redo').fire('click');
assert.equal(api.getSettings().normalizeEnabled, true);
api.changeSettings({ trimEnabled: true });
assert.equal(changes.at(-1).info.wordsMayChange, true);
nodes.get('reference-reset').fire('click');
assert.equal(api.getSettings().startSeconds, 0);
assert.equal(api.getSettings().endSeconds, 6);
assert.equal(api.getSettings().trimEnabled, false);
assert.equal(api.getSettings().normalizeEnabled, false);
assert.equal(hash(original), originalHash);
mark('Controller loads a saved source without edit events and distinguishes transcript-affecting edits from gain-only undo and redo');

const beforeBusy = changes.length;
api.setBusy(true); api.changeSettings({ startSeconds: 1 }); nodes.get('reference-undo').fire('click');
assert.equal(changes.length, beforeBusy);
assert.equal(nodes.get('reference-start').disabled, true);
api.setBusy(false); api.changeSettings({ startSeconds: -1 });
assert.equal(changes.length, beforeBusy);
assert.equal(api.getSettings().startSeconds, 0);
assert.equal(invalidMessages.length, 1);
assert.equal(nodes.get('reference-editor-error').hidden, false);
mark('Busy or invalid control changes do not alter the committed selection or emit audio edits');

const canvas = nodes.get('reference-waveform');
canvas.fire('pointerdown', { pointerId: 1, clientX: 200, button: 0 });
canvas.fire('pointermove', { pointerId: 1, clientX: 400 });
canvas.fire('pointerup', { pointerId: 1, clientX: 400 });
assert.equal(api.getSettings().startSeconds, 2); assert.equal(api.getSettings().endSeconds, 4);
const afterDrag = changes.length;
canvas.fire('pointerdown', { pointerId: 2, clientX: 100, button: 0 });
canvas.fire('pointermove', { pointerId: 2, clientX: 500 });
canvas.fire('pointercancel', { pointerId: 2 });
assert.equal(changes.length, afterDrag); assert.equal(api.getSettings().startSeconds, 2);
assert(canvasCalls.length > 0);
const peaks = api.waveformPeaks(new Float32Array([-.5, .25, -.75, 1]), 2);
assert.deepEqual(JSON.parse(JSON.stringify(peaks)), [[-.5,.25],[-.75,1]]);
mark('Waveform drag commits only on pointer release, cancelled drags retain the prior selection, and peaks cover source samples');

const oddLengthSource = original.slice(0, 77079);
api.setSource({ original: oddLengthSource, settings: { ...settings, endSeconds: oddLengthSource.length / rate } });
assert.equal(Number(nodes.get('reference-end').value), 3.211625);
// Changing one field must retain the other canonical sample boundary even if
// a rendered number was rounded (the regression in the first implementation).
nodes.get('reference-end').value = '3.212';
nodes.get('reference-start').value = '1.5';
nodes.get('reference-start').fire('change');
assert.equal(api.getSettings().endSeconds, 77079 / rate);
assert.equal(api.getSettings().startSeconds, 1.5);
const oddRange = processAudio(oddLengthSource, api.getSettings(), context.trimSamples, rate);
assert.equal(oddRange.samples.length, 77079 - 36000);
assert.equal(hash(oddRange.samples), hash(oddLengthSource.slice(36000)));
mark('Editing only the start preserves a 77,079-sample canonical end instead of reparsing a rounded display boundary');

context.document.activeElement = nodes.get('reference-start');
nodes.get('reference-start').value = '1.234';
api.setBusy(false); api.refreshLocale();
assert.equal(nodes.get('reference-start').value, '1.234');
assert.equal(api.getSettings().startSeconds, 1.5, 'An unfinished number is not committed by a status refresh');
nodes.get('reference-start').fire('change');
assert.equal(api.getSettings().startSeconds, 1.234);
nodes.get('reference-start').value = '1.';
api.setBusy(false); api.refreshLocale();
assert.equal(nodes.get('reference-start').value, '1.');
nodes.get('reference-reset').fire('click');
assert.equal(Number(nodes.get('reference-start').value), 0);
context.document.activeElement = null;
mark('Status-only and locale renders preserve focused uncommitted numeric input, while explicit change and reset still synchronize the canonical selection');

const files = ['app.js', 'reference-editor.js', 'index.html', ...catalogs];
const report = { created_at: new Date().toISOString(), node_version: process.version,
  scope: 'Actual shipped processAudio and trimSamples functions with deterministic float PCM. No real browser, media decoding, live HTTP, audio device or GPU is exercised.',
  browser_used: false, live_server_used: false, gpu_used: false,
  sources: Object.fromEntries(files.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')])),
  passed: checks.length, failed: 0, checks };
const destination = path.join(__dirname, 'reference_core_validation.json');
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: destination, passed: checks.length, failed: 0 }));
