"use strict";
(() => {
  const RATE = 24000;
  const copy = (value) => ({ ...value });
  const translate = (key, parameters) => window.StudioI18n.t(key, parameters);
  function processAudio(original, settings, trimFn, rate = RATE) {
    const start = Math.round(Number(settings.startSeconds) * rate);
    const end = Math.round(Number(settings.endSeconds) * rate);
    if (!original?.length || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > original.length || end - start < Math.ceil(.05 * rate)) throw new Error(translate("referenceX.invalidRange"));
    const selected = original.slice(start, end);
    let clipped = 0;
    for (const sample of selected) {
      if (!Number.isFinite(sample)) throw new Error(translate("referenceX.invalidSamples"));
      if (Math.abs(sample) >= 32767 / 32768) clipped++;
    }
    const trimmed = trimFn(selected, settings.trimEnabled !== false);
    let peak = 0;
    for (const sample of trimmed.samples) peak = Math.max(peak, Math.abs(sample));
    let gainDb = settings.normalizeEnabled && peak > 0 ? Math.min(12, 20 * Math.log10(10 ** (-3 / 20) / peak)) : 0;
    if (gainDb < -120 || !Number.isFinite(gainDb)) throw new Error(translate("referenceX.invalidSamples"));
    const gain = 10 ** (gainDb / 20);
    const samples = new Float32Array(trimmed.samples.length);
    let power = 0, peakAfter = 0;
    for (let i = 0; i < samples.length; i++) {
      samples[i] = trimmed.samples[i] * gain;
      power += samples[i] * samples[i];
      peakAfter = Math.max(peakAfter, Math.abs(samples[i]));
    }
    return { samples, startSeconds: (start + Math.round(trimmed.startSeconds * rate)) / rate,
      endSeconds: (original.length - end + Math.round(trimmed.endSeconds * rate)) / rate,
      originalSeconds: original.length / rate, selectionStartSeconds: start / rate, selectionEndSeconds: end / rate,
      normalizationGainDb: gainDb, peakBefore: peak, peakAfter, clippingCount: clipped,
      rms: Math.sqrt(power / samples.length), threshold: trimmed.threshold };
  }
  function createHistory(initial) {
    let entries = [copy(initial)], index = 0;
    return {
      get current() { return copy(entries[index]); }, get index() { return index; }, get length() { return entries.length; },
      commit(value) { if (JSON.stringify(value) === JSON.stringify(entries[index])) return false; entries = entries.slice(0, index + 1); entries.push(copy(value)); if (entries.length > 60) entries.shift(); index = entries.length - 1; return true; },
      undo() { if (index > 0) index--; return copy(entries[index]); },
      redo() { if (index + 1 < entries.length) index++; return copy(entries[index]); }
    };
  }
  function waveformPeaks(samples, bins) {
    const result = [];
    const width = Math.max(1, Math.floor(bins));
    for (let column = 0; column < width; column++) {
      const start = Math.floor(column * samples.length / width), end = Math.min(samples.length, Math.ceil((column + 1) * samples.length / width));
      let min = 0, max = 0;
      for (let i = start; i < end; i++) { min = Math.min(min, samples[i]); max = Math.max(max, samples[i]); }
      result.push([min, max]);
    }
    return result;
  }
  let bridge = null, source = null, history = null, busy = false, selectionUrl = "", drag = null, processed = null, localError = "", peakCache = null, invalidRange = null;
  const $ = (id) => document.getElementById(id);
  function stop() { const player = $("reference-selection-player"); if (player) player.pause(); }
  function release() {
    stop();
    const player = $("reference-selection-player");
    if (player) { player.removeAttribute("src"); player.load(); player.hidden = true; }
    if (selectionUrl) URL.revokeObjectURL(selectionUrl); selectionUrl = "";
  }
  function clear() {
    release(); source = null; history = null; drag = null; processed = null; localError = ""; busy = false; peakCache = null; invalidRange = null;
    if ($("reference-editor")) $("reference-editor").hidden = true;
  }
  function draw(settings = history?.current) {
    if (!source || !settings) return;
    const canvas = $("reference-waveform"), width = Math.max(200, canvas.clientWidth || 560), height = 108;
    const scale = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d"); if (!context) return;
    context.scale(scale, scale); context.clearRect(0, 0, width, height);
    const duration = source.length / RATE, start = settings.startSeconds / duration * width, end = settings.endSeconds / duration * width;
    context.fillStyle = "#eef3ef"; context.fillRect(0, 0, width, height);
    context.fillStyle = "#d0ebe4"; context.fillRect(start, 0, end - start, height);
    if (!peakCache || peakCache.source !== source || peakCache.width !== width) peakCache = { source, width, values: waveformPeaks(source, width) };
    const peaks = peakCache.values;
    context.strokeStyle = "#387f72"; context.lineWidth = 1; context.beginPath();
    peaks.forEach(([min, max], i) => { context.moveTo(i + .5, height / 2 - max * 44); context.lineTo(i + .5, height / 2 - min * 44); }); context.stroke();
    context.strokeStyle = "#007763"; context.lineWidth = 2;
    for (const x of [start, end]) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke(); }
  }
  function render(syncRange = false) {
    if (!bridge || !source || !history) return;
    const settings = history.current;
    $("reference-editor").hidden = false;
    for (const element of $("reference-editor").querySelectorAll("[data-reference-label]")) element.textContent = bridge.t(element.dataset.referenceLabel);
    $("reference-waveform").setAttribute("aria-label", bridge.t("referenceX.waveform"));
    $("reference-selection-player").setAttribute("aria-label", bridge.t("referenceX.selectionPreview"));
    for (const [id, field] of [["reference-start", "startSeconds"], ["reference-end", "endSeconds"]]) {
      const input = $(id);
      // Status, locale and asynchronous image updates must not replace a number
      // while it is still being typed. Explicit selection changes synchronize it.
      if (syncRange || document.activeElement !== input) input.value = invalidRange ? (Number.isFinite(invalidRange[field]) ? invalidRange[field] : "") : Number(settings[field].toFixed(6));
    }
    $("reference-start").max = $("reference-end").max = source.length / RATE;
    $("reference-normalize").checked = settings.normalizeEnabled;
    $("reference-original-length").textContent = bridge.t("referenceX.originalLength", { duration: (source.length / RATE).toFixed(2) });
    $("reference-range-summary").textContent = bridge.t("referenceX.range", { start: settings.startSeconds.toFixed(2), end: settings.endSeconds.toFixed(2), duration: (settings.endSeconds - settings.startSeconds).toFixed(2) });
    $("reference-undo").disabled = busy || history.index === 0;
    $("reference-redo").disabled = busy || history.index + 1 >= history.length;
    for (const id of ["reference-start", "reference-end", "reference-normalize", "reference-reset", "reference-play-selection"]) $(id).disabled = busy;
    $("reference-waveform").setAttribute("aria-disabled", String(busy));
    $("reference-editor-error").hidden = !localError;
    $("reference-editor-error").textContent = localError ? bridge.t(localError) : "";
    $("reference-quality").hidden = !processed;
    if (processed) {
      const peak = processed.peakAfter > 0 ? (20 * Math.log10(processed.peakAfter)).toFixed(1) : "−∞";
      $("reference-quality-summary").textContent = bridge.t("referenceX.quality", { duration: (processed.samples.length / RATE).toFixed(2), peak });
      $("reference-gain").textContent = bridge.t("referenceX.gain", { gain: `${processed.normalizationGainDb >= 0 ? "+" : ""}${processed.normalizationGainDb.toFixed(1)}` });
      $("reference-level-warning").hidden = !processed.clippingCount && processed.peakAfter >= .03;
      $("reference-level-warning").textContent = bridge.t(processed.clippingCount ? "referenceX.clipped" : "referenceX.quiet");
    }
    draw();
  }
  function emit(previous, next) {
    release(); processed = null; localError = ""; invalidRange = null;
    bridge.onChange(next, { wordsMayChange: previous.startSeconds !== next.startSeconds || previous.endSeconds !== next.endSeconds || previous.trimEnabled !== next.trimEnabled });
    render(true);
  }
  function commit(next) {
    if (!source || !history || busy) return;
    const start = Math.round(Number(next.startSeconds) * RATE), end = Math.round(Number(next.endSeconds) * RATE);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > source.length || end - start < Math.ceil(.05 * RATE)) {
      invalidRange = { startSeconds: Number(next.startSeconds), endSeconds: Number(next.endSeconds) };
      localError = "referenceX.invalidRange"; render(true); bridge.onInvalid?.(bridge.t(localError)); return;
    }
    next = { startSeconds: start / RATE, endSeconds: end / RATE, trimEnabled: next.trimEnabled !== false, normalizeEnabled: next.normalizeEnabled === true };
    const previous = history.current;
    invalidRange = null;
    if (history.commit(next)) emit(previous, next);
    else { localError = ""; bridge.onValid?.(); render(true); }
  }
  function restore(direction) {
    if (!history || busy) return;
    const previous = history.current, next = history[direction]();
    if (JSON.stringify(previous) !== JSON.stringify(next)) emit(previous, next);
  }
  function setSource({ original, settings }) {
    release(); source = original; processed = null; localError = ""; drag = null; peakCache = null; invalidRange = null;
    history = createHistory({ startSeconds: settings?.startSeconds ?? 0, endSeconds: settings?.endSeconds ?? original.length / RATE,
      trimEnabled: settings?.trimEnabled !== false, normalizeEnabled: settings?.normalizeEnabled === true });
    render(true);
  }
  function setProcessed(value) { processed = value; render(); }
  function setBusy(value) { busy = !!value; render(); }
  function init(options) {
    bridge = options;
    $("reference-editor").innerHTML = `<div class="reference-editor-heading"><h3 data-reference-label="referenceX.title"></h3><span id="reference-original-length"></span></div>
      <p class="reference-guide" data-reference-label="referenceX.guide"></p><canvas id="reference-waveform" role="img" aria-describedby="reference-range-hint reference-range-summary"></canvas>
      <p class="reference-editor-help" id="reference-range-hint" data-reference-label="referenceX.rangeHint"></p>
      <div class="reference-range-fields"><label><span data-reference-label="referenceX.start"></span><input id="reference-start" type="number" min="0" step="0.001" inputmode="decimal" aria-describedby="reference-editor-error"></label><label><span data-reference-label="referenceX.end"></span><input id="reference-end" type="number" min="0.05" step="0.001" inputmode="decimal" aria-describedby="reference-editor-error"></label></div>
      <p class="reference-range-summary" id="reference-range-summary" role="status"></p>
      <div class="reference-toolbar"><button type="button" class="button button-outline" id="reference-play-selection" data-reference-label="referenceX.playSelection"></button><button type="button" class="text-button" id="reference-undo" data-reference-label="referenceX.undo"></button><button type="button" class="text-button" id="reference-redo" data-reference-label="referenceX.redo"></button><button type="button" class="text-button" id="reference-reset" data-reference-label="referenceX.reset"></button></div>
      <audio id="reference-selection-player" controls preload="metadata" hidden></audio>
      <label class="reference-normalize-option"><input id="reference-normalize" type="checkbox"><span data-reference-label="referenceX.normalize"></span></label><p class="reference-editor-help" data-reference-label="referenceX.normalizeHint"></p>
      <div class="reference-quality" id="reference-quality" hidden><span id="reference-quality-summary"></span><span id="reference-gain"></span><p id="reference-level-warning" role="status" hidden></p></div>
      <p class="reference-editor-help" data-reference-label="referenceX.recommend"></p><p class="reference-editor-help" data-reference-label="referenceX.noAutoCheck"></p><div class="inline-error" id="reference-editor-error" role="alert" hidden></div>`;
    const numeric = (id) => String($(id).value).trim() === "" ? NaN : Number($(id).value);
    for (const [id, field] of [["reference-start", "startSeconds"], ["reference-end", "endSeconds"]]) $(id).addEventListener("change", () => commit({ ...history.current, ...invalidRange, [field]: numeric(id) }));
    $("reference-normalize").addEventListener("change", () => commit({ ...history.current, normalizeEnabled: $("reference-normalize").checked }));
    $("reference-undo").addEventListener("click", () => restore("undo"));
    $("reference-redo").addEventListener("click", () => restore("redo"));
    $("reference-reset").addEventListener("click", () => commit({ startSeconds: 0, endSeconds: source.length / RATE, trimEnabled: false, normalizeEnabled: false }));
    $("reference-play-selection").addEventListener("click", async () => {
      if (!source || busy) return;
      release(); bridge.onPreviewStart?.();
      const settings = history.current;
      const samples = source.slice(Math.round(settings.startSeconds * RATE), Math.round(settings.endSeconds * RATE));
      selectionUrl = URL.createObjectURL(bridge.encodePcmWav(samples));
      const player = $("reference-selection-player"); player.src = selectionUrl; player.hidden = false;
      try { await player.play(); } catch { /* Native controls remain available if autoplay is denied. */ }
    });
    const canvas = $("reference-waveform");
    const secondsAt = (event) => { const rect = canvas.getBoundingClientRect(); return Math.max(0, Math.min(source.length / RATE, (event.clientX - rect.left) / rect.width * source.length / RATE)); };
    canvas.addEventListener("pointerdown", (event) => {
      if (!source || busy || (event.button !== undefined && event.button !== 0)) return;
      event.preventDefault(); stop();
      const settings = history.current, position = secondsAt(event), tolerance = 12 / canvas.getBoundingClientRect().width * source.length / RATE;
      drag = { id: event.pointerId, anchor: position, initial: settings, next: settings, mode: Math.abs(position - settings.startSeconds) < tolerance ? "start" : Math.abs(position - settings.endSeconds) < tolerance ? "end" : "new" };
      canvas.setPointerCapture?.(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id || busy) return;
      const value = secondsAt(event), next = { ...drag.initial };
      if (drag.mode === "start") next.startSeconds = Math.min(value, next.endSeconds - .05);
      else if (drag.mode === "end") next.endSeconds = Math.max(value, next.startSeconds + .05);
      else { next.startSeconds = Math.min(value, drag.anchor); next.endSeconds = Math.max(value, drag.anchor); }
      drag.next = next; draw(next);
    });
    canvas.addEventListener("pointerup", (event) => { if (!drag || event.pointerId !== drag.id) return; const next = drag.next; drag = null; commit(next); });
    canvas.addEventListener("pointercancel", () => { drag = null; draw(); });
    window.addEventListener("resize", () => draw());
  }
  window.StudioReferenceEditor = { init, clear, setSource, setProcessed, setBusy, stop, refreshLocale: render,
    getSettings: () => history?.current || null, changeSettings: (value) => history && commit({ ...history.current, ...value }),
    processAudio, createHistory, waveformPeaks };
})();
