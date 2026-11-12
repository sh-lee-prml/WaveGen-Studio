// Run: node tests/test_frontend_trim.cjs
// Tests the actual UI functions without opening a browser or running the GPU.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const sourcePath = path.resolve(__dirname, '../web/app.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const i18nPath = path.join(path.dirname(sourcePath), 'i18n.js');
const i18nSource = fs.readFileSync(i18nPath, 'utf8');
const constantStart = source.indexOf('  const SAMPLE_RATE =');
const constantEnd = source.indexOf('  const icons =');
const functionStart = source.indexOf('  function trimSamples(');
const functionEnd = source.indexOf('  function applyAudioProcessing(');
assert(constantStart >= 0 && constantEnd > constantStart && functionStart >= 0 && functionEnd > functionStart);
const sandbox = { Blob, Float32Array, DataView, ArrayBuffer, Math, Number, Error,
  window: {}, localStorage: { getItem: () => null, setItem: () => {} } };
vm.createContext(sandbox);
vm.runInContext(i18nSource, sandbox, { filename: i18nPath });
sandbox.t = sandbox.window.StudioI18n.t;
vm.runInContext(source.slice(constantStart, constantEnd) + '\n' + source.slice(functionStart, functionEnd), sandbox);
// Require the intended validation error, not a missing-dependency ReferenceError.
const expectedError = key => ({ name: 'Error', message: sandbox.t(key) });
const sampleRate = 24000;
const checks = [];
const checksum = samples => crypto.createHash('sha256').update(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)).digest('hex');

function toneFixture(amplitude, internalSilence = 0) {
  const audio = new Float32Array((6 + internalSilence) * sampleRate);
  for (let i = 2 * sampleRate; i < 3 * sampleRate; i++) audio[i] = amplitude * Math.sin(2 * Math.PI * 220 * i / sampleRate);
  if (internalSilence) {
    for (let i = (3 + internalSilence) * sampleRate; i < (4 + internalSilence) * sampleRate; i++) audio[i] = amplitude * Math.sin(2 * Math.PI * 220 * i / sampleRate);
  }
  return audio;
}

async function main() {
  const original = toneFixture(.2);
  const originalHash = checksum(original);
  const trimmed = sandbox.trimSamples(original, true);
  assert(Math.abs(trimmed.startSeconds - 1.85) < 1e-6);
  assert(Math.abs(trimmed.endSeconds - 2.85) < 1e-6);
  assert.equal(trimmed.samples.length, 31200);
  checks.push({ name: 'Edge silence removal preserves 150 ms padding', passed: true, source_seconds: 6, leading_silence_seconds: 2, speech_seconds: 1, trailing_silence_seconds: 3, removed_start_seconds: trimmed.startSeconds, removed_end_seconds: trimmed.endSeconds, output_seconds: trimmed.samples.length / sampleRate });

  const quiet = sandbox.trimSamples(toneFixture(.0001), true);
  assert.equal(quiet.samples.length, trimmed.samples.length);
  checks.push({ name: 'Quiet speech is retained by the adaptive threshold', passed: true, peak_amplitude: .0001, threshold: quiet.threshold, output_seconds: quiet.samples.length / sampleRate });

  const restored = sandbox.trimSamples(original, false);
  assert.equal(restored.samples.length, original.length);
  assert.equal(checksum(restored.samples), originalHash);
  const retrimmed = sandbox.trimSamples(original, true);
  assert.equal(checksum(retrimmed.samples), checksum(trimmed.samples));
  assert.equal(checksum(original), originalHash);
  checks.push({ name: 'On/off/on toggle preserves the original and does not accumulate trimming', passed: true, original_sha256: originalHash, restored_seconds: restored.samples.length / sampleRate, retrimmed_seconds: retrimmed.samples.length / sampleRate });

  const spaced = sandbox.trimSamples(toneFixture(.2, 2), true);
  assert.equal(spaced.samples.length, 103200);
  for (let i = Math.round((3 - 1.85) * sampleRate); i < Math.round((5 - 1.85) * sampleRate); i++) assert.equal(spaced.samples[i], 0);
  checks.push({ name: 'Internal two-second pause is preserved', passed: true, internal_silence_seconds: 2, output_seconds: spaced.samples.length / sampleRate });

  assert.throws(() => sandbox.trimSamples(new Float32Array(sampleRate), true), expectedError('error.audioSilent'));
  assert.throws(() => sandbox.trimSamples(new Float32Array(sampleRate), false), expectedError('error.audioSilent'));
  checks.push({ name: 'All-silence source is rejected with trimming enabled or disabled', passed: true });

  assert.throws(() => sandbox.trimSamples(toneFixture(.000001), true), expectedError('error.audioSilent'));
  checks.push({ name: 'Below-floor near-silent input is rejected', passed: true, peak_amplitude: .000001 });

  const briefImpulse = new Float32Array(sampleRate);
  briefImpulse[12000] = 1;
  assert.throws(() => sandbox.trimSamples(briefImpulse, true), expectedError('error.audioTooShort'));
  checks.push({ name: 'A single impulse is insufficient as a voice sample', passed: true });

  const wav = await sandbox.encodePcmWav(trimmed.samples).arrayBuffer();
  const view = new DataView(wav);
  assert.equal(Buffer.from(wav, 0, 4).toString('ascii'), 'RIFF');
  assert.equal(Buffer.from(wav, 8, 4).toString('ascii'), 'WAVE');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), sampleRate);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), trimmed.samples.length * 2);
  assert.equal(wav.byteLength, 44 + trimmed.samples.length * 2);
  checks.push({ name: 'WAV output is mono 24 kHz PCM16 with consistent lengths', passed: true, sample_rate: sampleRate, channels: 1, bits_per_sample: 16, bytes: wav.byteLength });

  const report = {
    created_at: new Date().toISOString(),
    source: sourcePath,
    source_sha256: crypto.createHash('sha256').update(source).digest('hex'),
    i18n_source: i18nPath,
    i18n_source_sha256: crypto.createHash('sha256').update(i18nSource).digest('hex'),
    validation_error_locale: sandbox.window.StudioI18n.getLocale(),
    validation_error_messages_checked: true,
    test_scope: 'Actual trimSamples and encodePcmWav functions extracted from the frontend source. Browser decoding/resampling and UI interaction are covered separately by the parent agent.',
    algorithm: { rms_window_ms: 10, base_threshold_dbfs: -45, adaptive_threshold_formula: 'max(1e-5, min(10^(-45/20), peak_window_rms * 0.04))', edge_padding_ms: 150, minimum_active_windows: 3, all_silence_peak_rms_floor: 1e-5, original_buffer_mutated: false },
    passed: checks.length,
    failed: 0,
    checks,
  };
  const reportPath = path.join(__dirname, 'frontend_trim_validation.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: reportPath, passed: report.passed, failed: report.failed }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
