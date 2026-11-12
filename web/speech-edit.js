"use strict";
(() => {
  // Native output WAVs are decoded directly, retaining their exact sample clock.
  function decodeWav(buffer) {
    const view = new DataView(buffer);
    const tag = (offset) => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
    if (view.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("edit.unsupported");
    let format = 0, channels = 0, rate = 0, align = 0, bits = 0, offset = -1, size = 0;
    for (let at = 12; at + 8 <= view.byteLength;) {
      const count = view.getUint32(at + 4, true), start = at + 8;
      if (count > view.byteLength - start) throw new Error("edit.unsupported");
      if (tag(at) === "fmt ") {
        if (count < 16) throw new Error("edit.unsupported");
        format = view.getUint16(start, true); channels = view.getUint16(start + 2, true);
        rate = view.getUint32(start + 4, true); align = view.getUint16(start + 12, true); bits = view.getUint16(start + 14, true);
        if (format === 65534 && count >= 40) format = view.getUint16(start + 24, true);
      } else if (tag(at) === "data") { offset = start; size = count; }
      at = start + count + (count & 1);
    }
    if (rate !== 24000 || channels !== 1 || align !== bits / 8 || offset < 0 || size < align || size % align || !((format === 1 && [16,24,32].includes(bits)) || (format === 3 && bits === 32))) throw new Error("edit.unsupported");
    const samples = new Float32Array(size / align);
    for (let index = 0; index < samples.length; index++) {
      const pos = offset + index * align;
      let value;
      if (format === 3) value = view.getFloat32(pos, true);
      else if (bits === 16) value = view.getInt16(pos, true) / 32768;
      else if (bits === 24) { let n = view.getUint8(pos) | view.getUint8(pos + 1) << 8 | view.getUint8(pos + 2) << 16; if (n & 0x800000) n |= 0xff000000; value = n / 8388608; }
      else value = view.getInt32(pos, true) / 2147483648;
      if (!Number.isFinite(value)) throw new Error("edit.unsupported");
      samples[index] = value;
    }
    return { samples, sampleRate: rate, duration: samples.length / rate };
  }
  function peaks(samples, width) {
    width = Math.max(1, Math.floor(width));
    const values = new Float32Array(width * 2);
    for (let x = 0; x < width; x++) {
      const from = Math.floor(x * samples.length / width), to = Math.max(from + 1, Math.floor((x + 1) * samples.length / width));
      let low = 0, high = 0;
      for (let at = from; at < Math.min(to, samples.length); at++) { low = Math.min(low, samples[at]); high = Math.max(high, samples[at]); }
      values[x * 2] = low; values[x * 2 + 1] = high;
    }
    return values;
  }
  function sampleRange(start, end, count, rate = 24000) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > count / rate + 0.5 / rate) return null;
    const first = Math.round(start * rate), last = Math.min(count, Math.round(end * rate));
    return last - first >= Math.round(rate * .1) ? { first, last, seconds: (last - first) / rate } : null;
  }
  function segmentRanges(item) {
    if (item.transcript_stale || !Array.isArray(item.segments)) return [];
    let end = 0;
    const segments = item.segments.map((segment, index) => {
      const start = Number.isFinite(segment.start_seconds) ? segment.start_seconds : end + (index ? .12 : 0);
      end = Number.isFinite(segment.end_seconds) ? segment.end_seconds : start + Number(segment.duration_seconds);
      return { start, end, text: String(segment.text || "") };
    });
    return segments.length && segments.every(s => s.start >= 0 && s.end > s.start) && Math.abs(end - Number(item.duration_seconds)) < .002 ? segments : [];
  }
  window.StudioSpeechEditCore = { decodeWav, peaks, sampleRange, segmentRanges };

  let hooks, dialog, audio, originalAudio, resizeObserver;
  let state = null, loadRevision = 0, planRevision = 0, playRevision = 0, planTimer, playTimer;
  let recoveryTimer = null, pendingJob = null;
  // Keep metadata only: decoded audio and playback objects are released on close.
  // Active requests use the separate sessionStorage recovery path below.
  const closedSessions = [];
  let nextSessionId = 0;
  const PENDING_KEY = "wavegen.speechEdit.pending.v1", AUTO_RECOVERY_CHECKS = 5;
  const $ = id => document.getElementById(id);
  const t = (key, params) => hooks.t(key, params);
  const escape = value => hooks.escapeHtml(value);
  const fixed = seconds => Number(seconds).toFixed(3);
  const sampleTime = seconds => Number(Number(seconds).toFixed(6));
  const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
  const busy = () => state?.busy;
  function mark(key, tag = "span", attributes = "") { return `<${tag} data-i18n="${key}" ${attributes}>${escape(t(key))}</${tag}>`; }
  function setError(message = "") {
    if (!state) return;
    state.error = message;
    $("edit-error").textContent = window.StudioI18n.translate(message);
    $("edit-error").hidden = !message;
  }
  function announce(message) { $("edit-announcement").textContent = message; }
  function captureSelection() {
    return { start:state.start,end:state.end,text:$("edit-text").value,autoTextRange:state.autoTextRange,
      operation:state.operation,modelId:state.modelId,seed:$("edit-seed").value,voice:$("edit-voice").value,match:$("edit-match-duration").checked };
  }
  function rememberSession() {
    if (!state || busy()) return;
    if (state.wave) state.selections.set(state.item.id, captureSelection());
    if (!state.selections.size) return;
    const existing = closedSessions.findIndex(session => session.id === state.sessionId);
    if (existing >= 0) closedSessions.splice(existing, 1);
    closedSessions.push({ id:state.sessionId, dataKey:state.dataKey, original:state.original, versions:state.versions.slice(),
      selections:new Map([...state.selections].map(([id, selection]) => [id, { ...selection }])) });
    if (closedSessions.length > 20) closedSessions.shift();
  }
  function renderDraftNotice() {
    $("edit-draft-notice").hidden = !state?.restoredSession;
    $("edit-draft-notice").textContent = state?.restoredSession ? t("editUx.draftRestored") : "";
  }
  function readPendingEdit() {
    try {
      const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null");
      return pending?.version === 1 && /^[a-f0-9]{32}$/.test(pending.requestId || "") && pending.source?.id && pending.body?.source_id === pending.source.id ? pending : null;
    } catch { return null; }
  }
  function storePendingEdit(value) {
    pendingJob = value;
    try { if (value) sessionStorage.setItem(PENDING_KEY, JSON.stringify(value)); else sessionStorage.removeItem(PENDING_KEY); }
    catch { /* Recovery in this open window still works if storage is blocked. */ }
  }
  function renderRecovery() {
    if (!state) return;
    $("edit-recovery").hidden = !state.recovering;
    $("edit-recovery-status").textContent = t(state.recoveryChecking ? "editUx.checking" : state.recoveryMessage || "editUx.uncertain");
    $("edit-recovery-check").disabled = !!state.recoveryChecking;
    $("edit-stop-waiting").hidden = !state.recoveryCanStop;
    $("edit-stop-waiting-hint").hidden = !state.recoveryCanStop;
    $("edit-stop-waiting").disabled = !!state.recoveryChecking;
  }
  function scheduleRecovery(delay = 1000) {
    clearTimeout(recoveryTimer);
    if (!state?.recovering || state.recoveryChecks >= AUTO_RECOVERY_CHECKS) { recoveryTimer = null; return; }
    const editorState = state;
    recoveryTimer = setTimeout(() => { recoveryTimer = null; if (state === editorState) return recoverPendingEdit(); }, delay);
  }
  function editError(error) {
    return state?.operation==="regenerate" && $("edit-match-duration").checked && /dense|tokens?.*(?:many|exceed|length)|too short|target.*(?:small|short)|insufficient/i.test(String(error?.message || "")) ? t("edit.tooShort") : hooks.readableError(error, state?.modelId);
  }
  function init(options) {
    if (dialog) return;
    hooks = options;
    dialog = document.createElement("dialog"); dialog.id = "speech-edit-dialog"; dialog.className = "speech-edit-dialog";
    dialog.setAttribute("aria-labelledby", "speech-edit-title");
    dialog.innerHTML = `<div class="speech-edit-heading"><div>${mark("edit.eyebrow", "p", 'class="eyebrow"')}${mark("edit.title", "h2", 'id="speech-edit-title"')}</div><button type="button" class="icon-button" id="edit-close" data-i18n-aria-label="common.close" aria-label="${escape(t("common.close"))}">×</button></div>${mark("edit.description", "p", 'class="speech-edit-description"')}
      <div class="edit-recording-meta"><strong id="edit-recording-name"></strong><span id="edit-recording-duration"></span></div><p id="edit-draft-notice" class="edit-hint" role="status" hidden></p>
      <div id="edit-loading" role="status">${escape(t("edit.loading"))}</div>
      <div id="edit-workspace" hidden>
        <div class="edit-wave-toolbar"><span id="edit-selection-label"></span><div>${mark("edit.zoom", "label", 'for="edit-zoom"')}<select id="edit-zoom"><option value="1" data-i18n="edit.zoomFit">${escape(t("edit.zoomFit"))}</option><option value="2">2×</option><option value="4">4×</option><option value="8">8×</option></select></div></div>
        <div class="edit-wave-scroll" id="edit-wave-scroll"><div class="edit-wave-track" id="edit-wave-track"><canvas id="edit-waveform" role="img" data-i18n-aria-label="edit.waveform" aria-label="${escape(t("edit.waveform"))}"></canvas><div class="edit-selection" id="edit-selection"><span id="edit-handle-start" data-handle="start" role="slider" tabindex="0" aria-label="${escape(t("edit.start"))}" aria-valuemin="0"></span><span id="edit-handle-end" data-handle="end" role="slider" tabindex="0" aria-label="${escape(t("edit.end"))}" aria-valuemin="0"></span></div><div id="edit-playhead" class="edit-playhead" hidden></div><div id="edit-wave-ticks" class="edit-wave-ticks"></div></div></div>
        <div class="edit-range-row"><label>${mark("edit.start")}<input id="edit-start" type="number" min="0" step="0.001"></label><label>${mark("edit.end")}<input id="edit-end" type="number" min="0" step="0.001"></label><button id="edit-select-all" type="button" class="button button-quiet">${mark("edit.selectAll")}</button><button id="edit-play-selection" type="button" class="button button-outline">${mark("edit.playSelection")}</button><button id="edit-stop" type="button" class="text-button">${mark("edit.stop")}</button></div>
        <div id="edit-segments-wrap" class="edit-segments-wrap" hidden>${mark("edit.segmentHint", "p")}<div id="edit-segments" class="edit-segments"></div></div>
        <div class="edit-current-player">${mark("edit.currentAudio", "label", 'for="edit-player"')}<audio id="edit-player" controls preload="metadata"></audio></div>
        <div class="edit-version-row"><button type="button" class="text-button" id="edit-undo">${mark("edit.undo")}</button><button type="button" class="text-button" id="edit-redo">${mark("edit.redo")}</button><details id="edit-compare">${mark("edit.compare", "summary")}<audio id="edit-original-player" controls preload="none" aria-label="${escape(t("edit.originalAudio"))}"></audio></details></div>
        <fieldset class="edit-options" id="edit-options"><legend data-i18n="edit.operation">${escape(t("edit.operation"))}</legend><div class="edit-operation-buttons" role="group"><button type="button" data-edit-op="regenerate" aria-pressed="true">${mark("edit.regenerate")}</button><button type="button" data-edit-op="cut" aria-pressed="false">${mark("edit.cut")}</button><button type="button" data-edit-op="keep" aria-pressed="false">${mark("edit.keep")}</button></div><p id="edit-operation-hint" class="edit-hint"></p>
        <div id="edit-regenerate-fields"><div class="generation-mode edit-generation-mode"><label for="edit-model" data-i18n="models.label">${escape(t("models.label"))}</label><select id="edit-model" aria-describedby="edit-model-hint edit-model-scope"></select><p id="edit-model-hint" role="status"></p><p id="edit-model-scope" data-i18n="models.editHint">${escape(t("models.editHint"))}</p></div><label class="edit-text-field">${mark("edit.text")}<textarea id="edit-text" rows="3" maxlength="5000" lang="en" spellcheck="true" data-i18n-placeholder="edit.textPlaceholder" placeholder="${escape(t("edit.textPlaceholder"))}"></textarea><small data-i18n="edit.textHint">${escape(t("edit.textHint"))}</small></label><div class="edit-generation-options"><label>${mark("edit.voice")}<select id="edit-voice"></select></label><label>${mark("composer.seed")}<span class="edit-seed-field"><input id="edit-seed" type="number" min="0" max="4294967295" step="1" value="0"><button type="button" id="edit-seed-random" class="button button-quiet">${mark("features.seedRandom")}</button></span></label></div><label class="edit-match"><input type="checkbox" id="edit-match-duration" checked>${mark("edit.matchDuration")}</label>${mark("edit.matchHint", "p", 'class="edit-hint"')}</div></fieldset>
        <details class="edit-source-text">${mark("edit.sourceText", "summary")}<p id="edit-source-transcript"></p></details>${mark("edit.transcriptNote", "p", 'class="edit-hint"')}
      </div><div id="edit-error" class="inline-error" role="alert" hidden></div><div id="edit-recovery" class="edit-recovery" hidden><p id="edit-recovery-status" role="status"></p><button id="edit-recovery-check" type="button" class="button button-outline">${mark("editUx.checkAgain")}</button><p id="edit-stop-waiting-hint" hidden>${mark("editUx.stopWaitingHint")}</p><button id="edit-stop-waiting" type="button" class="button button-quiet" aria-describedby="edit-stop-waiting-hint" hidden>${mark("editUx.stopWaiting")}</button></div><div id="edit-announcement" class="sr-only" role="status" aria-live="polite"></div><footer class="edit-footer"><span id="edit-plan-status" role="status"></span><div><button id="edit-cancel-job" type="button" class="button button-quiet" hidden>${mark("edit.cancel")}</button><button id="edit-apply" type="button" class="button button-primary" disabled>${mark("edit.apply")}</button></div></footer>`;
    document.body.append(dialog); audio = $("edit-player"); originalAudio = $("edit-original-player");
    $("edit-close").addEventListener("click", close);
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    $("edit-start").addEventListener("input", inputRange); $("edit-end").addEventListener("input", inputRange);
    $("edit-select-all").addEventListener("click", () => select(0, state.wave.duration));
    $("edit-play-selection").addEventListener("click", playSelection);
    $("edit-stop").addEventListener("click", stop);
    $("edit-zoom").addEventListener("change", drawWave);
    for (const id of ["edit-seed", "edit-voice", "edit-match-duration"]) $(id).addEventListener("input", schedulePlan);
    $("edit-model").addEventListener("change", () => {
      if (!state || busy() || ["generating", "loading_model"].includes(hooks.getStatus().state)) { refreshModels(); return; }
      state.modelId = $("edit-model").value; refreshModels(); schedulePlan();
    });
    $("edit-text").addEventListener("input", () => { if(state)state.autoTextRange=null; schedulePlan(); });
    $("edit-seed-random").addEventListener("click", () => { $("edit-seed").value = randomSeed(); schedulePlan(); });
    dialog.querySelectorAll("[data-edit-op]").forEach(button => button.addEventListener("click", () => { state.operation = button.dataset.editOp; refreshOperation(); schedulePlan(); }));
    $("edit-apply").addEventListener("click", apply);
    $("edit-cancel-job").addEventListener("click", cancelJob);
    $("edit-recovery-check").addEventListener("click", () => { if (state?.recovering) { state.recoveryChecks = 0; recoverPendingEdit(); } });
    $("edit-stop-waiting").addEventListener("click", stopWaiting);
    $("edit-undo").addEventListener("click", () => stepVersion(-1)); $("edit-redo").addEventListener("click", () => stepVersion(1));
    $("edit-segments").addEventListener("click", event => { const button = event.target.closest("[data-segment]"); if (!button || busy()) return; const segment = segmentRanges(state.item)[Number(button.dataset.segment)]; if (segment) { $("edit-text").value = segment.text; state.autoTextRange=segment; select(segment.start, segment.end); } });
    const track = $("edit-wave-track");
    track.addEventListener("pointerdown", pointerDown); track.addEventListener("pointermove", pointerMove); track.addEventListener("pointerup", pointerUp); track.addEventListener("pointercancel", pointerUp);
    for (const side of ["start", "end"]) $("edit-handle-" + side).addEventListener("keydown", event => {
      if (!state?.wave || busy() || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const step = event.shiftKey ? .5 : .05;
      const value = event.key === "Home" ? 0 : event.key === "End" ? state.wave.duration : state[side] + (event.key === "ArrowLeft" ? -step : step);
      if (side === "start") select(Math.max(0, Math.min(state.end - .1, value)), state.end); else select(state.start, Math.min(state.wave.duration, Math.max(state.start + .1, value)));
    });
    audio.addEventListener("timeupdate", updatePlayhead); audio.addEventListener("pause", updatePlayhead); audio.addEventListener("ended", stopTimer);
    if (typeof ResizeObserver !== "undefined") { resizeObserver = new ResizeObserver(() => { if (dialog.open && state?.wave) drawWave(); }); resizeObserver.observe($("edit-wave-scroll")); }
    const interrupted = readPendingEdit();
    if (interrupted) setTimeout(() => restorePendingEdit(interrupted), 0);
  }
  async function open(item, interrupted = null) {
    const status = hooks.getStatus();
    if (!interrupted && (["generating", "loading_model", "stopped"].includes(status.state) || status.stopped || status.busy || busy())) return hooks.showToast(t("edit.busy"), true);
    if (!item?.id || !hooks.safeAudioUrl(item.audio_url)) return hooks.showToast(t("edit.loadError"), true);
    const dataKey = status.data_key || "";
    const saved = !interrupted && closedSessions.slice().reverse().find(session => session.dataKey === dataKey && session.versions.some(version => version.id === item.id));
    state = { item, original: saved?.original || item, versions: saved ? saved.versions.slice() : [item], version: saved ? saved.versions.findIndex(version => version.id === item.id) : 0,
      selections:saved ? new Map([...saved.selections].map(([id, selection]) => [id, { ...selection }])) : new Map(),
      sessionId:saved?.id || ++nextSessionId, dataKey, restoredSession:!!saved,
      autoTextRange:null, modelId: hooks.modelId(item.model_id), modelError: "", operation: "regenerate", start: 0, end: 0, busy: false, wave: null, plan: null, error: "", drag: null, recovering: false, recoveryChecks: 0, recoveryIdle: 0 };
    $("edit-text").value = ""; $("edit-seed").value = Number.isInteger(item.seed) ? item.seed : 0;
    $("edit-zoom").value = "1"; $("edit-match-duration").checked = true;
    originalAudio.src = hooks.safeAudioUrl(state.original.audio_url); $("edit-compare").open = false;
    announce("");
    refreshVoices(item.voice_id); dialog.showModal();
    if (interrupted) { state.requestId = interrupted.requestId; state.recovering = true; state.recoveryMessage = "editUx.restoring"; setBusy(true); }
    refreshLocale(); await loadItem(item);
  }
  function close() {
    if (busy()) return setError(t("edit.closeBusy"));
    rememberSession();
    stop(); ++loadRevision; ++planRevision; clearTimeout(planTimer); clearTimeout(recoveryTimer); recoveryTimer = null; dialog.close();
    audio.removeAttribute("src"); audio.load(); originalAudio.removeAttribute("src"); originalAudio.load(); state = null;
  }
  function refreshVoices(preferred) {
    const previous = preferred || $("edit-voice").value;
    $("edit-voice").innerHTML = `<option value="">${escape(t("edit.noVoice"))}</option>` + hooks.getVoices().map(voice => `<option value="${escape(voice.id)}">${escape(voice.name)}</option>`).join("");
    $("edit-voice").value = previous;
  }
  function refreshModels() {
    if (!state || !dialog) return;
    const externalBusy = ["generating", "loading_model"].includes(hooks.getStatus().state);
    hooks.renderModelControl("edit-model", "edit-model-hint", state.modelId, busy() || externalBusy);
    const previous = state.modelError;
    state.modelError = state.operation === "regenerate" ? hooks.modelIssue(state.modelId) : "";
    if (state.modelError && !busy()) $("edit-apply").disabled = true;
    if (previous !== state.modelError && state.wave && !busy()) schedulePlan();
    const observedRequest = hooks.getStatus().request_id;
    if (state.recovering && typeof observedRequest === "string" && observedRequest !== state.recoveryObservedRequest) {
      state.recoveryObservedRequest = observedRequest;
      if (!state.recoveryChecking && observedRequest !== state.requestId) { state.recoveryChecks = 0; scheduleRecovery(0); }
    }
  }
  async function loadItem(item) {
    const revision = ++loadRevision;
    if(state.wave)state.selections.set(state.item.id,captureSelection());
    state.item = item; state.wave = null; state.plan = null; ++planRevision; clearTimeout(planTimer); stop();
    $("edit-workspace").hidden = true; $("edit-loading").hidden = false; $("edit-apply").disabled = true; setError();
    $("edit-recording-name").textContent = item.voice_name || t("common.voice");
    $("edit-recording-duration").textContent = hooks.formatDuration(item.duration_seconds);
    try {
      const url = hooks.safeAudioUrl(item.audio_url);
      if (!url) throw new Error("edit.loadError");
      let response = await fetch(url, { credentials: "same-origin" });
      if (response.status === 403) { await fetch("/", { credentials: "same-origin", cache: "no-store" }); response = await fetch(url, { credentials: "same-origin" }); }
      if (!response.ok) throw new Error("edit.loadError");
      const wave = decodeWav(await response.arrayBuffer());
      if (revision !== loadRevision || !state || !dialog.open) return;
      state.wave = wave; audio.src = url; audio.load();
      $("edit-loading").hidden = true; $("edit-workspace").hidden = false;
      $("edit-source-transcript").textContent = item.text || "";
      $("edit-start").max = sampleTime(wave.duration); $("edit-end").max = sampleTime(wave.duration);
      const segments = segmentRanges(item), saved=state.selections.get(item.id);
      state.modelId = saved ? saved.modelId : hooks.modelId(item.model_id);
      if(saved) {state.start=saved.start;state.end=saved.end;state.operation=saved.operation;state.autoTextRange=saved.autoTextRange;$("edit-text").value=saved.text;$("edit-seed").value=saved.seed;$("edit-voice").value=saved.voice;$("edit-match-duration").checked=saved.match;}
      else if (segments.length && state.operation==="regenerate") { $("edit-text").value = segments[0].text; state.start = segments[0].start; state.end = segments[0].end; state.autoTextRange=segments[0]; }
      else { $("edit-text").value = ""; state.autoTextRange=null; state.start = 0; state.end = Math.min(3,Math.max(.1,wave.duration/2)); }
      renderSegments(); refreshOperation(); refreshModels(); updateRange(); drawWave(); updateVersions(); schedulePlan();
    } catch (error) { if (revision === loadRevision && state) { $("edit-loading").hidden = true; setError(error.message.startsWith("edit.") ? t(error.message) : t("edit.loadError")); } }
  }
  function renderSegments() {
    const segments = segmentRanges(state.item);
    $("edit-segments-wrap").hidden = !segments.length;
    $("edit-segments").innerHTML = segments.map((segment, index) => `<button class="text-button" type="button" data-segment="${index}" title="${escape(segment.text)}" ${busy()?"disabled":""}>${escape(t("edit.segment", { number: index + 1 }))}<small>${fixed(segment.start)}–${fixed(segment.end)}s</small></button>`).join("");
  }
  function updateVersions() {
    $("edit-undo").disabled = busy() || state.version === 0;
    $("edit-redo").disabled = busy() || state.version >= state.versions.length - 1;
    $("edit-compare").hidden = state.item.id === state.original.id;
  }
  async function stepVersion(step) {
    if (busy()) return;
    const version = state.version + step;
    if (version < 0 || version >= state.versions.length) return;
    const editorState=state, item=state.versions[version];
    state.version = version; const loaded=loadItem(item), revision=loadRevision; await loaded;
    if(state!==editorState || !dialog.open || loadRevision!==revision || state.item.id!==item.id || !state.wave)return;
    try { await hooks.onResult(item); } catch(error) { if(state===editorState && dialog.open)setError(hooks.readableError(error)); }
  }
  function stopTimer() { clearInterval(playTimer); playTimer = null; }
  function stop() { ++playRevision; stopTimer(); audio?.pause(); originalAudio?.pause(); }
  function playSelection() {
    const range = state?.wave && sampleRange(state.start, state.end, state.wave.samples.length);
    if (!range) return setError(t("edit.rangeError"));
    stop(); const revision=playRevision,editorState=state,end=range.last/24000; audio.currentTime = range.first / 24000;
    audio.play().then(() => {
      if(revision!==playRevision || state!==editorState || !dialog.open)return;
      playTimer = setInterval(() => { if (state!==editorState || audio.currentTime >= end || audio.paused) { audio.pause(); stopTimer(); } updatePlayhead(); }, 20);
    }).catch(error => {if(revision===playRevision&&state===editorState)setError(hooks.readableError(error));});
  }
  function updatePlayhead() {
    if (!state?.wave) return;
    $("edit-playhead").hidden = false; $("edit-playhead").style.left = `${Math.min(100, audio.currentTime / state.wave.duration * 100)}%`;
  }
  function drawWave() {
    if (!state?.wave || !dialog.open) return;
    const width = Math.max(240, $("edit-wave-scroll").clientWidth) * Number($("edit-zoom").value);
    const track = $("edit-wave-track"), canvas = $("edit-waveform"); track.style.width = `${width}px`;
    const ratio = Math.min(2, window.devicePixelRatio || 1), height = 164;
    canvas.width = Math.round(width * ratio); canvas.height = height * ratio; canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d"); ctx.scale(ratio, ratio); ctx.clearRect(0,0,width,height);
    const envelope = peaks(state.wave.samples, width);
    let maximum = .05; for (const value of envelope) maximum = Math.max(maximum, Math.abs(value));
    ctx.strokeStyle = "#91b5a6"; ctx.lineWidth = 1; ctx.beginPath();
    for (let x=0; x<width; x++) { ctx.moveTo(x+.5, height/2-envelope[x*2]*64/maximum); ctx.lineTo(x+.5, height/2-envelope[x*2+1]*64/maximum); } ctx.stroke();
    ctx.strokeStyle = "#cad9d0"; ctx.beginPath(); ctx.moveTo(0,height/2); ctx.lineTo(width,height/2); ctx.stroke();
    const tickCount = Math.max(4, Math.round(width / 120));
    $("edit-wave-ticks").innerHTML = Array.from({length:tickCount+1},(_,i)=>`<span style="left:${i/tickCount*100}%">${(i/tickCount*state.wave.duration).toFixed(1)}s</span>`).join("");
    paintSelection(); updatePlayhead();
  }
  function paintSelection() {
    if (!state?.wave) return;
    const left = Math.max(0, Math.min(100,state.start/state.wave.duration*100)), right = Math.max(left, Math.min(100,state.end/state.wave.duration*100));
    $("edit-selection").style.left = `${left}%`; $("edit-selection").style.width = `${right-left}%`;
    $("edit-selection-label").textContent = t("edit.selection", { seconds: Math.max(0,state.end-state.start).toFixed(3) });
    for (const side of ["start","end"]) { const handle=$("edit-handle-"+side); handle.setAttribute("aria-valuenow",fixed(state[side])); handle.setAttribute("aria-valuemax",fixed(state.wave.duration)); handle.setAttribute("aria-label",t("edit."+side)); }
  }
  function updateRange() { $("edit-start").value = sampleTime(state.start); $("edit-end").value = sampleTime(state.end); paintSelection(); }
  function select(start,end) { if (!state?.wave || busy()) return; stop(); state.start=Math.round(start*24000)/24000; state.end=Math.round(end*24000)/24000; updateRange(); schedulePlan(); }
  function inputRange(event) {
    if (!state?.wave || busy()) return;
    stop();
    // Reparse only the field that changed; the other end keeps its exact sample
    // boundary instead of importing a rounded display value.
    for (const side of ["start", "end"]) if (!event || event.target === $("edit-" + side)) state[side] = $("edit-" + side).value === "" ? NaN : Number($("edit-" + side).value);
    if (Number.isFinite(state.start) && Number.isFinite(state.end)) paintSelection();
    schedulePlan();
  }
  function timeAt(event) { const rect=$("edit-wave-track").getBoundingClientRect(); return Math.min(state.wave.duration,Math.max(0,(event.clientX-rect.left)/rect.width*state.wave.duration)); }
  function pointerDown(event) {
    if (!state?.wave || busy() || event.button !== 0) return;
    event.preventDefault(); stop(); const anchor=timeAt(event), side=event.target.closest("[data-handle]")?.dataset.handle;
    state.drag={anchor,side,pointer:event.pointerId}; $("edit-wave-track").setPointerCapture(event.pointerId);
    if (!side) { state.start=anchor; state.end=anchor; } updateRange();
  }
  function pointerMove(event) {
    if (!state?.drag || state.drag.pointer!==event.pointerId) return;
    const time=timeAt(event), {side,anchor}=state.drag;
    if (side==="start") state.start=Math.min(state.end-.1,time); else if(side==="end") state.end=Math.max(state.start+.1,time);
    else {state.start=Math.min(anchor,time);state.end=Math.max(anchor,time);}
    state.start=Math.max(0,state.start);state.end=Math.min(state.wave.duration,state.end);updateRange();
  }
  function pointerUp(event) {
    if (!state?.drag || state.drag.pointer!==event.pointerId) return;
    if (state.end-state.start<.1) { state.end=Math.min(state.wave.duration,state.start+.2);state.start=Math.max(0,Math.min(state.start,state.end-.1)); }
    state.drag=null; select(state.start,state.end);
  }
  function refreshOperation() {
    if (!state) return;
    dialog.querySelectorAll("[data-edit-op]").forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.editOp===state.operation)));
    $("edit-regenerate-fields").hidden=state.operation!=="regenerate";
    $("edit-operation-hint").textContent=t("edit."+state.operation+"Hint");
    refreshModels();
  }
  function requestBody() {
    return {source_id:state.item.id,operation:state.operation,start_seconds:state.start,end_seconds:state.end,
      ...(state.operation==="regenerate"?{model_id:state.modelId,text:$("edit-text").value.trim(),seed:Number($("edit-seed").value),voice_id:$("edit-voice").value,duration_seconds:$("edit-match-duration").checked?state.end-state.start:0}:{})};
  }
  function validation(body) {
    const range=sampleRange(body.start_seconds,body.end_seconds,state.wave.samples.length);
    if (!range) return "edit.rangeError";
    if (body.operation==="cut"&&state.wave.duration-range.seconds<.1-1/24000) return "edit.cutAllError";
    if (body.operation==="keep"&&range.first===0&&range.last===state.wave.samples.length) return "edit.noChanges";
    if (body.operation==="regenerate") {
      if (!body.text) return "edit.textError";
      if (!body.voice_id) return "edit.noVoice";
      if (!Number.isInteger(body.seed)||body.seed<0||body.seed>4294967295) return "error.seed";
      if (body.duration_seconds!==0&&(body.duration_seconds<.2||body.duration_seconds>600)) return "edit.matchError";
    }
    return "";
  }
  function schedulePlan() {
    if (!state?.wave || busy()) return;
    if(state.autoTextRange && (Math.abs(state.start-state.autoTextRange.start)>1/24000 || Math.abs(state.end-state.autoTextRange.end)>1/24000)) {
      if($("edit-text").value===state.autoTextRange.text)$("edit-text").value="";
      state.autoTextRange=null;
    }
    clearTimeout(planTimer); const revision=++planRevision; state.plan=null; state.planning=false; $("edit-apply").disabled=true;
    const body=requestBody(), issue=validation(body); state.issue=issue;
    state.modelError=body.operation==="regenerate"?hooks.modelIssue(body.model_id):"";
    const guidance=issue==="edit.textError"||issue==="edit.noVoice";
    setError(state.modelError || (issue&&!guidance?t(issue):""));
    if (state.modelError || issue) { $("edit-plan-status").textContent=guidance?t(issue):""; return; }
    state.planning=true; $("edit-plan-status").textContent=t("edit.planning");
    planTimer=setTimeout(async()=>{
      try {
        const result=await hooks.api("/api/edit/plan",{method:"POST",json:body,timeout:15000});
        if (revision!==planRevision||!state||!dialog.open) return;
        state.plan={key:JSON.stringify(body),value:result}; updatePlanLabel(); $("edit-apply").disabled=false;
      } catch(error) { if(revision===planRevision&&state) {state.plan=null;$("edit-plan-status").textContent="";setError(editError(error));} }
      finally {if(revision===planRevision&&state)state.planning=false;}
    },250);
  }
  function updatePlanLabel() {
    if (!state?.plan) return;
    const result=state.plan.value;
    $("edit-plan-status").textContent=t("edit.plan",{total:Number(result.duration_seconds).toFixed(3),selection:Number(result.selection_duration_seconds).toFixed(3),replacement:Number(result.replacement_duration_seconds).toFixed(3)});
  }
  function setBusy(value) {
    state.busy=value; hooks.onBusyChange?.(value); $("edit-options").disabled=value;
    for(const id of ["edit-start","edit-end","edit-select-all","edit-zoom","edit-close"]) $(id).disabled=value;
    $("edit-segments").querySelectorAll("button").forEach(button=>button.disabled=value);
    $("edit-cancel-job").hidden=!value||state.operation!=="regenerate"; $("edit-cancel-job").disabled=false;
    $("edit-apply").disabled=value||!state.plan; $("edit-apply").textContent=t(value?"edit.applying":"edit.apply");
    updateVersions(); refreshModels(); renderRecovery();
  }
  function clearPendingEdit() {
    clearTimeout(recoveryTimer); recoveryTimer = null;
    storePendingEdit(null);
    if (state) { state.requestId = null; state.recovering = false; state.recoveryChecks = 0; state.recoveryIdle = 0; state.recoveryCanStop = false; }
  }
  function stopWaiting() {
    if (!state?.recovering || !state.recoveryCanStop || state.recoveryChecking) return;
    // This is only an explicit dismissal of local tracking, never a claim that
    // the native request was cancelled, nor permission to resubmit it.
    clearPendingEdit(); setBusy(false); close();
  }
  async function acceptEditedResult(item) {
    const editorState = state;
    state.restoredSession = false; renderDraftNotice();
    state.versions = state.versions.slice(0, state.version + 1);
    if (state.versions.at(-1)?.id !== item.id) state.versions.push(item);
    state.version = state.versions.length - 1;
    let warning = "";
    try { await hooks.onResult(item); } catch (error) { warning = hooks.readableError(error); }
    if (state !== editorState) return;
    await loadItem(item);
    if (state === editorState && warning) setError(warning);
  }
  async function recoverPendingEdit() {
    if (!state?.recovering || !state.requestId || state.recoveryChecking) return;
    clearTimeout(recoveryTimer); recoveryTimer = null;
    const editorState = state, requestId = state.requestId;
    state.recoveryChecking = true; state.recoveryChecks++; renderRecovery();
    try {
      // getStatus() deliberately masks the parent UI as busy for our own job.
      // Only the native endpoint can authoritatively confirm completion.
      const [status, history] = await Promise.all([
        hooks.api("/api/status", { timeout: 7000 }), hooks.api(`/api/history?limit=60&q=${encodeURIComponent(requestId)}`, { timeout: 10000 })
      ]);
      if (state !== editorState || state.requestId !== requestId) return;
      if (pendingJob?.dataKey && status.data_key && pendingJob.dataKey !== status.data_key) {
        clearPendingEdit(); setBusy(false); setError(t("editUx.otherData")); return;
      }
      const item = history.items?.find(value => value.request_id === requestId);
      if (status.request_id === requestId) {
        state.recoveryIdle = 0; state.recoveryCanStop = false; state.recoveryMessage = "editUx.waiting";
        $("edit-cancel-job").disabled = status.can_cancel === false || !!pendingJob?.cancelled;
      } else if (item) {
        await acceptEditedResult(item);
        if (state !== editorState) return;
        clearPendingEdit(); setBusy(false); schedulePlan(); announce(t("editUx.recovered")); hooks.showToast(t("editUx.recovered"));
      } else if (["ready", "error", "stopped"].includes(status.state) || (typeof status.request_id === "string" && status.request_id)) {
        // An unobserved POST may still be preparing before reserving its native
        // slot. Idle observations alone cannot prove that it will never run.
        state.recoveryIdle++;
        if (state.recoveryIdle >= 2) {
          if (pendingJob?.cancelled) {
            clearPendingEdit(); setBusy(false); schedulePlan();
            const message = t("edit.cancelled");
            setError(); announce(message); hooks.showToast(message);
          } else { state.recoveryCanStop = true; state.recoveryMessage = "editUx.uncertain"; }
        } else state.recoveryMessage = "editUx.uncertain";
      } else { state.recoveryIdle = 0; state.recoveryCanStop = false; state.recoveryMessage = "editUx.uncertain"; }
    } catch {
      if (state === editorState && state.requestId === requestId) { state.recoveryIdle = 0; state.recoveryCanStop = false; state.recoveryMessage = "editUx.uncertain"; }
    } finally {
      if (state === editorState) {
        state.recoveryChecking = false; renderRecovery();
        if (state.recovering) scheduleRecovery();
      }
    }
  }
  async function restorePendingEdit(pending) {
    if (state) return;
    pendingJob = pending;
    const opening = open(pending.source, pending), editorState = state;
    await opening;
    if (!editorState || state !== editorState || state.requestId !== pending.requestId) return;
    const body = pending.body;
    state.operation = body.operation; state.start = body.start_seconds; state.end = body.end_seconds; state.autoTextRange = null;
    state.modelId = hooks.modelId(body.model_id ?? pending.source.model_id);
    $("edit-text").value = body.text || ""; $("edit-seed").value = body.seed ?? 0;
    refreshVoices(body.voice_id); $("edit-match-duration").checked = Number(body.duration_seconds) > 0;
    if (state.wave) updateRange();
    refreshOperation(); setBusy(true); renderRecovery();
    await recoverPendingEdit();
  }
  async function apply() {
    if (!state?.wave||busy()) return;
    const body=requestBody();
    if ((body.operation==="regenerate"&&hooks.modelIssue(body.model_id))||validation(body)||state.plan?.key!==JSON.stringify(body)) {schedulePlan();return;}
    const status=hooks.getStatus(); if (["generating","loading_model","stopped"].includes(status.state)||status.busy) return setError(t("edit.busy"));
    const requestId=Array.from(crypto.getRandomValues(new Uint8Array(16)),value=>value.toString(16).padStart(2,"0")).join("");
    const editorState = state;
    state.requestId=requestId; stop(); setError();
    storePendingEdit({ version: 1, requestId, source: state.item, body, dataKey: status.data_key || "", cancelled: false });
    setBusy(true); let item;
    try {
      const payload=await hooks.api("/api/edit",{method:"POST",json:{...body,request_id:requestId}});
      if(payload.cancelled) {announce(t("edit.cancelled"));hooks.showToast(t("edit.cancelled"));return;}
      item=payload.result||payload;
      await acceptEditedResult(item); announce(t("edit.saved"));hooks.showToast(t("edit.saved"));
    } catch(error) {
      if (!error.status) {
        if (state !== editorState) return;
        state.recovering = true; state.recoveryChecks = 0; state.recoveryIdle = 0;
        state.recoveryObservedRequest = hooks.getStatus().request_id;
        state.recoveryMessage = "editUx.uncertain"; renderRecovery();
        await recoverPendingEdit();
      } else setError(editError(error));
    } finally {
      if (state === editorState && !state.recovering) { clearPendingEdit(); setBusy(false); if(item)schedulePlan(); }
    }
  }
  async function cancelJob() {
    if(!busy()||!state.requestId)return;
    const editorState=state,requestId=state.requestId;
    $("edit-cancel-job").disabled=true;
    try {
      await hooks.api("/api/cancel",{method:"POST",json:{request_id:requestId},timeout:10000});
      if(state===editorState&&state.requestId===requestId&&pendingJob) { pendingJob.cancelled=true; storePendingEdit(pendingJob); }
      if(state===editorState&&state.recovering) {state.recoveryChecks=0;scheduleRecovery(0);}
    }
    catch(error){if(state===editorState&&state.requestId===requestId&&busy()){setError(hooks.readableError(error));$("edit-cancel-job").disabled=false;if(state.recovering){state.recoveryChecks=0;scheduleRecovery(0);}}}
  }
  function refreshLocale() {
    if(!dialog)return;
    window.StudioI18n.applyStatic(dialog);
    if(!state)return;
    renderDraftNotice();
    $("edit-loading").textContent=t("edit.loading");$("edit-recording-duration").textContent=hooks.formatDuration(state.item.duration_seconds);
    audio.setAttribute("aria-label",t("edit.currentAudio"));originalAudio.setAttribute("aria-label",t("edit.originalAudio"));
    refreshVoices();refreshOperation();refreshModels();renderSegments();paintSelection();updatePlanLabel();
    if(state.planning)$("edit-plan-status").textContent=t("edit.planning");
    $("edit-announcement").textContent=window.StudioI18n.translate($("edit-announcement").textContent);
    $("edit-apply").textContent=t(busy()?"edit.applying":"edit.apply");
    if(state.modelError)setError(state.modelError);
    else if(state.issue==="edit.textError"||state.issue==="edit.noVoice")$("edit-plan-status").textContent=t(state.issue);
    else if(state.issue)setError(t(state.issue));else if(state.error)setError(window.StudioI18n.translate(state.error));
    renderRecovery();
  }
  window.StudioSpeechEdit={init,open,refreshLocale,refreshModels};
})();
