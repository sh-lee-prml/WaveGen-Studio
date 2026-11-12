"use strict";

(() => {
  const i18n = window.StudioI18n;
  const t = (key, params) => i18n.t(key, params);
  const $ = (id) => document.getElementById(id);
  const SAMPLE_RATE = 24000;
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const MAX_AVATAR_BYTES = 10 * 1024 * 1024;
  const MAX_AVATAR_PIXELS = 4096 * 4096;
  const MAX_AVATAR_SIDE = 8192;
  const MAX_SOURCE_SECONDS = 120;
  const MAX_REFERENCE_SECONDS = 30;
  const TRIM_WINDOW = 240; // 10 ms at 24 kHz.
  const TRIM_PADDING = 3600; // Preserve 150 ms at both spoken edges.
  const TRIM_BASE_THRESHOLD = Math.pow(10, -45 / 20);
  const TRIM_FLOOR = 1e-5;
  const icons = {
    check: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 10 4 4 8-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m7 4 9 6-9 6V4Z" fill="currentColor"/></svg>',
    voice: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 8v4m3-7v10m4-12v14m4-10v6m3-5v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 17v3h14v-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const generateIcon = $("generate-icon").innerHTML;
  const initialDraft = readDraft();
  const pendingRequest = readPending();
  const state = {
    voices: [], trash: [], history: [], selectedId: initialDraft.voice_id, modelId: initialDraft.model_id,
    activeResultId: "", status: { state: "loading" }, voicesLoading: true,
    generating: false, speechEditing: false, enhancementJob: null, saving: false, shuttingDown: false, stopped: false,
    statusPending: false, voicesRequest: 0, voicesError: "", modal: null, toastTimer: null,
    historyError: "", historyLoading: true, historyRequest: 0, historyLimit: 12, historyQuery: "",
    historyPageIds: null, historyCursor: null, historyHasMore: false, historyTotal: null, historyMoreLoading: false, historySearchTimer: null,
    trashLoading: false, trashError: "", trashRequest: 0, showingTrash: false, restoring: new Set(),
    warnings: {}, unsavedResults: new Map(), renderedResultId: "", requireVoiceSelection: false,
    plan: { state: "empty", key: "" }, planRevision: 0, planTimer: null,
    request: pendingRequest, recovering: !!pendingRequest, cancelPending: false,
    authPromise: null, connected: false, pollTimer: null,
    errorMessages: {}, toast: null,
  };

  function readStorage(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  }
  function writeStorage(key, value) {
    try { localStorage.setItem(key, String(value)); } catch { /* A private browser can still use the app. */ }
  }
  function readDraft() {
    let saved;
    try { saved = JSON.parse(readStorage("wavegen.draft.v1", "null")); } catch { saved = null; }
    if (saved?.version !== 1) saved = { text: readStorage("wavegen.draft", ""), voice_id: readStorage("wavegen.voice", "") };
    return { version: 1, model_id: modelId(saved.model_id), text: typeof saved.text === "string" ? saved.text.slice(0, 5000) : "", voice_id: String(saved.voice_id || ""), speed: Number.isFinite(Number(saved.speed)) && Number(saved.speed) >= .5 && Number(saved.speed) <= 2 ? Number(saved.speed) : 1, seed: Number.isInteger(Number(saved.seed)) && Number(saved.seed) >= 0 && Number(saved.seed) <= 4294967295 ? Number(saved.seed) : 0, randomize_seed: saved.randomize_seed === true, duration_mode: saved.duration_mode === "target" ? "target" : "auto", duration_seconds: Number.isFinite(Number(saved.duration_seconds)) && Number(saved.duration_seconds) >= .2 && Number(saved.duration_seconds) <= 600 ? Number(saved.duration_seconds) : 10, split_long_text: saved.split_long_text !== false, enhance_output: saved.enhance_output === true };
  }
  function currentDraft() {
    return { version: 1, model_id: state.modelId, text: $("generation-text").value, voice_id: state.selectedId, speed: Number($("speed").value), seed: $("seed").value === "" ? 0 : Number($("seed").value), randomize_seed: $("seed-every-time").checked, duration_mode: $("duration-mode").value === "target" ? "target" : "auto", duration_seconds: Number($("duration-seconds").value), split_long_text: $("split-long-text").checked, enhance_output: $("enhance-output").checked };
  }
  function persistDraft() { writeStorage("wavegen.draft.v1", JSON.stringify(currentDraft())); }
  function readPending() {
    try { const pending = JSON.parse(sessionStorage.getItem("wavegen.pending") || "null"); return /^[a-f0-9]{32}$/.test(pending?.id || "") ? pending : null; } catch { return null; }
  }
  function storePending(request) {
    try { if (request) sessionStorage.setItem("wavegen.pending", JSON.stringify(request)); else sessionStorage.removeItem("wavegen.pending"); } catch { /* Recovery remains available through history. */ }
  }
  function clearPending() { state.request = null; state.recovering = false; state.cancelPending = false; storePending(null); }
  function recoveryOutputs(request) {
    const matching = state.history.filter(item => item.request_id === request?.id);
    const needsEnhancement = request?.kind === "enhancement" || request?.draft?.enhance_output === true;
    return { completed: needsEnhancement ? matching.find(item => item.enhanced === true) : matching[0],
      raw: needsEnhancement ? matching.find(item => item.enhanced !== true) || state.history.find(item => String(item.id) === String(request?.source_id)) : null };
  }
  function nativeBusy(value = state.status.state) { return ["generating", "loading_model", "loading_enhancement", "enhancing"].includes(value); }
  function isBusy() { return state.generating || state.speechEditing || !!state.enhancementJob || state.recovering || nativeBusy(); }
  function enhancementAvailable() { return state.status.enhancement?.available === true; }
  function enhancementIssue() { return $("enhance-output").checked && !enhancementAvailable() ? t("enhance.unavailable") : ""; }
  function enhancementStatusText() {
    if (state.status.state === "loading_enhancement") return t("enhance.loading");
    if (state.status.state === "enhancing") return t("enhance.working");
    if (!enhancementAvailable()) return t("enhance.unavailable");
    return t(state.status.enhancement?.loaded ? "enhance.available" : "enhance.firstUse");
  }
  function newRequestId() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join(""); }
  function modelId(value) { return value == null ? "flash" : String(value); }
  function modelName(id) { return id === "flash" ? "Flash" : id === "vspec" ? "V-Spec" : id || t("models.choose"); }
  function modelInfo(id) {
    if (Array.isArray(state.status.models)) return state.status.models.find(model => model.id === id);
    // Old servers/history supported only Flash. Do not silently enable V-Spec.
    return id === "flash" ? { id, available: true, loaded: state.status.state === "ready" } : null;
  }
  function modelIssue(id = state.modelId) {
    if (!["flash", "vspec"].includes(id)) return t("models.unknown", { model: modelName(id) });
    if (!modelInfo(id)?.available) return t("models.unavailable", { model: modelName(id) });
    return "";
  }
  function modelResultLabel(item) {
    const id = modelId(item.model_id), steps = Number(item.steps ?? item.model_steps ?? (id === "flash" ? 4 : id === "vspec" ? 50 : 0));
    const label = steps > 0 ? t("models.result", { model: item.model_name || modelName(id), steps }) : modelName(id);
    return item.model_scope === "replacement" ? t("models.replacementResult", { mode: label }) : item.model_scope === "inherited" ? t("models.inheritedResult", { mode: label }) : label;
  }
  function renderModelControl(selectId, hintId, id, disabled) {
    const select = $(selectId), hint = $(hintId);
    if (!select || !hint) return;
    const options = ["flash", "vspec"].map(value => {
      const available = !!modelInfo(value)?.available, label = t("models." + value);
      return `<option value="${value}" ${available ? "" : "disabled"}>${escapeHtml(available ? label : t("models.unavailableOption", { label }))}</option>`;
    });
    if (!["flash", "vspec"].includes(id)) options.push(`<option value="${escapeHtml(id)}">${escapeHtml(modelName(id))}</option>`);
    const html = options.join("");
    if (select.dataset.modelOptions !== html) { select.innerHTML = html; select.dataset.modelOptions = html; }
    select.value = id; select.disabled = !!disabled;
    const issue = modelIssue(id), loading = state.status.state === "loading_model" && state.status.active_model_id === id;
    hint.textContent = issue || (loading ? t("models.loading", { model: modelName(id) }) : [t("models." + id + "Hint"), modelInfo(id)?.loaded ? "" : t("models.firstUse", { model: modelName(id) })].filter(Boolean).join(" "));
    hint.classList.toggle("is-error", !!issue);
    select.setAttribute("aria-invalid", String(!!issue));
  }
  function setText(id, text) { if ($(id) && $(id).textContent !== String(text)) $(id).textContent = text; }
  function textIssue(text, limit, label) {
    if (!text.trim()) return "";
    const invalid = [...new Set(Array.from(text).filter((char) => char.codePointAt(0) > 127 && !"‘’“”".includes(char)))];
    if (invalid.length) {
      const names = { "—": t("validation.emDash"), "–": t("validation.enDash"), "…": t("validation.ellipsis"), "\u00a0": t("validation.nbsp"), "\u200b": t("validation.zeroWidth") };
      const examples = invalid.slice(0, 3).map((char) => names[char] || `“${char}”`).join(", ");
      return t("validation.unsupported", { label, characters: examples });
    }
    if (new TextEncoder().encode(text.trim()).length > limit) return t("validation.tooLong", { label });
    return "";
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function safeAudioUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin && /^(https?:)$/.test(url.protocol) ? url.href : "";
    } catch { return ""; }
  }
  function safeSourceUrl(value) {
    try { const url = new URL(String(value)); return /^https?:$/.test(url.protocol) ? url.href : ""; } catch { return ""; }
  }
  function avatarContents(voice) {
    const url = safeAudioUrl(voice?.avatar_url);
    return `<span class="avatar-initials">${escapeHtml(voice ? avatarName(voice.name) : "W")}</span>${url ? `<img data-voice-avatar src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async">` : ""}`;
  }
  function imageDimensions(buffer) {
    const view = new DataView(buffer), length = view.byteLength;
    const ascii = (offset, size) => offset + size <= length ? String.fromCharCode(...new Uint8Array(buffer, offset, size)) : "";
    let width = 0, height = 0;
    if (length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && ascii(12, 4) === "IHDR") {
      width = view.getUint32(16); height = view.getUint32(20);
    } else if (length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
      for (let at = 12; at + 8 <= length;) {
        const type = ascii(at, 4), size = view.getUint32(at + 4, true), start = at + 8;
        if (size > length - start) throw new Error(t("libraryX.imageDecode"));
        if (type === "VP8X" && size >= 10) {
          width = 1 + view.getUint8(start + 4) + (view.getUint8(start + 5) << 8) + (view.getUint8(start + 6) << 16);
          height = 1 + view.getUint8(start + 7) + (view.getUint8(start + 8) << 8) + (view.getUint8(start + 9) << 16); break;
        }
        if (type === "VP8 " && size >= 10 && view.getUint8(start + 3) === 0x9d && view.getUint8(start + 4) === 1 && view.getUint8(start + 5) === 0x2a) {
          width = view.getUint16(start + 6, true) & 0x3fff; height = view.getUint16(start + 8, true) & 0x3fff; break;
        }
        if (type === "VP8L" && size >= 5 && view.getUint8(start) === 0x2f) {
          const bits = view.getUint32(start + 1, true); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; break;
        }
        at = start + size + (size & 1);
      }
    } else if (length >= 4 && view.getUint16(0) === 0xffd8) {
      let at = 2;
      const frames = [0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf];
      while (at + 4 <= length) {
        if (view.getUint8(at++) !== 0xff) break;
        while (at < length && view.getUint8(at) === 0xff) at++;
        if (at >= length) break;
        const marker = view.getUint8(at++);
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 1 || (marker >= 0xd0 && marker <= 0xd8)) continue;
        if (at + 2 > length) break;
        const size = view.getUint16(at);
        if (size < 2 || size > length - at) break;
        if (frames.includes(marker) && size >= 7) { height = view.getUint16(at + 3); width = view.getUint16(at + 5); break; }
        at += size;
      }
    } else throw new Error(t("libraryX.imageFormat"));
    if (!width || !height) throw new Error(t("libraryX.imageDecode"));
    if (width > MAX_AVATAR_SIDE || height > MAX_AVATAR_SIDE || width * height > MAX_AVATAR_PIXELS) throw new Error(t("libraryX.imagePixels"));
    return { width, height };
  }
  async function prepareAvatar(file) {
    if (!file.size || file.size > MAX_AVATAR_BYTES) throw new Error(t(file.size ? "libraryX.imageLarge" : "libraryX.imageDecode"));
    imageDimensions(await file.arrayBuffer()); // Read dimensions before allocating a decoded bitmap.
    let bitmap, objectUrl = "";
    try {
      if (typeof createImageBitmap === "function") bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      else {
        objectUrl = URL.createObjectURL(file);
        bitmap = await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error(t("libraryX.imageDecode"))); image.src = objectUrl; });
      }
      const width = bitmap.width || bitmap.naturalWidth, height = bitmap.height || bitmap.naturalHeight;
      if (!width || !height || width > MAX_AVATAR_SIDE || height > MAX_AVATAR_SIDE || width * height > MAX_AVATAR_PIXELS) throw new Error(t("libraryX.imagePixels"));
      const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 512;
      const context = canvas.getContext("2d");
      if (!context) throw new Error(t("libraryX.imageEncode"));
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
      const side = Math.min(width, height);
      context.drawImage(bitmap, (width - side) / 2, (height - side) / 2, side, side, 0, 0, 512, 512);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      if (!blob || blob.size > 2 * 1024 * 1024) throw new Error(t("libraryX.imageEncode"));
      return new File([blob], "character.png", { type: "image/png" });
    } catch (error) {
      const known = ["libraryX.imagePixels", "libraryX.imageEncode", "libraryX.imageDecode"].map(key => t(key));
      throw new Error(known.includes(error.message) ? error.message : t("libraryX.imageDecode"));
    } finally { bitmap?.close?.(); if (objectUrl) URL.revokeObjectURL(objectUrl); }
  }
  function selectedVoice() { return state.voices.find((voice) => String(voice.id) === state.selectedId); }
  function avatarName(name) {
    const words = String(name || "W").trim().split(/\s+/);
    return words.length > 1 ? (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase() : Array.from(words[0]).slice(0, 2).join("").toUpperCase();
  }
  function avatarColor(id) {
    return Array.from(String(id)).reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 5;
  }
  function formatDuration(seconds) {
    if (!Number.isFinite(Number(seconds))) return "";
    const value = Math.max(0, Number(seconds));
    return value >= 60 ? `${Math.floor(value / 60)}:${Math.floor(value % 60).toString().padStart(2, "0")}` : t("common.durationSeconds", { seconds: value.toFixed(1) });
  }
  function formatDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const today = new Date();
    const locale = { en: "en-US", ko: "ko-KR", zh: "zh-CN", ja: "ja-JP" }[i18n.getLocale()];
    const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
    return date.toDateString() === today.toDateString() ? t("common.today", { time }) : `${date.toLocaleDateString(locale, { month: "short", day: "numeric" })} ${time}`;
  }
  function showToast(message, error = false, action = null) {
    clearTimeout(state.toastTimer);
    state.toast = { message, error, action };
    $("toast-container").innerHTML = `<div class="toast${error ? " is-error" : ""}"><span id="toast-message">${escapeHtml(Array.isArray(message) ? message.join(" ") : message)}</span>${action ? `<button type="button" id="toast-action">${escapeHtml(action.label)}</button>` : ""}</div>`;
    if (action) $("toast-action").addEventListener("click", () => { clearTimeout(state.toastTimer); $("toast-container").replaceChildren(); state.toast = null; action.run(); });
    state.toastTimer = setTimeout(() => { $("toast-container").replaceChildren(); state.toast = null; }, action ? 12000 : error ? 6500 : 3500);
  }
  function setError(id, message = "") {
    state.errorMessages[id] = message;
    $(id).textContent = i18n.translate(message);
    $(id).hidden = !message;
  }
  function readableError(error, modelContext = state.modelId) {
    const rawModelMessage = String(error?.message || "");
    if (/Unknown generation model/i.test(rawModelMessage)) return t("models.unknown", { model: modelName(modelContext) });
    if (/(V-Spec|Flash) model is not installed/i.test(rawModelMessage)) return t("models.unavailable", { model: /V-Spec/i.test(rawModelMessage) ? "V-Spec" : "Flash" });
    if (/Failed to load (V-Spec|Flash) model/i.test(rawModelMessage)) return t("models.loadError", { model: /V-Spec/i.test(rawModelMessage) ? "V-Spec" : "Flash" });
    if (error?.name === "AbortError") return t("error.slowConnection");
    if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return t("error.network");
    const message = String(error?.message || t("error.generic"));
    if (/5000.*byte|5000 UTF/i.test(message)) return t("error.textLong");
    if (/4000.*byte|transcript.*(length|long)/i.test(message)) return t("error.transcriptLong");
    if (/English ASCII|Chinese\/pinyin/i.test(message)) return t("error.english");
    if (/leave room|frame budget|1500 frames|duration\/speed|exceeds.*30/i.test(message)) return t("error.length");
    if (/100 segments/i.test(message)) return t("error.tooManySections");
    if (/token.*(dense|frames|length|many)|text.*(dense|token)|tokens.*exceed/i.test(message)) return t($("duration-mode").value === "target" ? "features.durationTooShort" : "error.denseText");
    if (/target duration is too short/i.test(message)) return t("features.durationTooShort");
    if (/duration_seconds.*(range|between|finite|0\.2|600)|target duration.*(range|between)/i.test(message)) return t("features.durationError");
    if (/finished.*saved|finished.*saving/i.test(message)) return t("error.finishing");
    if (/currently generating.*(edit|delete)/i.test(message)) return t("error.voiceBusy");
    if (/no longer|not found|does not exist/i.test(message)) return t("error.missingData");
    const localized = i18n.translate(message);
    return localized !== message || Object.values(i18n.getCatalog(i18n.getLocale())).includes(message) ? localized : t("error.details", { details: message.slice(0, 700) });
  }
  async function authenticatedFetch(path, options = {}, retry = true) {
    const response = await fetch(path, { ...options, credentials: "same-origin" });
    if (response.status !== 403 || !retry) return response;
    if (!state.authPromise) state.authPromise = fetch("/", { credentials: "same-origin", cache: "no-store" }).then((page) => { if (!page.ok) throw new Error(t("error.auth")); }).finally(() => { state.authPromise = null; });
    await state.authPromise;
    return authenticatedFetch(path, options, false);
  }
  async function api(path, options = {}) {
    const { json, timeout, ...request } = options;
    const headers = new Headers(request.headers || {});
    if ((request.method || "GET").toUpperCase() !== "GET") headers.set("X-WaveGen-Client", "studio");
    if (json !== undefined) { headers.set("Content-Type", "application/json"); request.body = JSON.stringify(json); }
    const controller = timeout ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
    try {
      const response = await authenticatedFetch(path, { ...request, headers, signal: controller?.signal });
      const body = await response.text();
      let payload;
      try { payload = body ? JSON.parse(body) : {}; } catch { payload = {}; }
      if (!response.ok) {
        const error = new Error(typeof payload.error === "string" ? payload.error : (payload.message || t("error.http", { status: response.status })));
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    } finally { if (timer) clearTimeout(timer); }
  }

  function updateWarnings(source, warnings) {
    state.warnings[source] = (Array.isArray(warnings) ? warnings : warnings ? [warnings] : []).map((item) => typeof item === "string" ? item : item.message || JSON.stringify(item));
    const all = [...new Set(Object.values(state.warnings).flat())];
    $("warnings-panel").hidden = !all.length;
    $("warnings-count").textContent = all.length ? `(${all.length})` : "";
    $("warnings-list").innerHTML = all.map((warning) => `<li>${escapeHtml(i18n.translate(warning) !== warning ? i18n.translate(warning) : t("warnings.details", { details: warning }))}</li>`).join("");
  }

  function renderVoices() {
    $("voice-count").textContent = state.voices.length;
    $("trash-count").textContent = state.trash.length;
    $("library-active").setAttribute("aria-pressed", String(!state.showingTrash));
    $("library-trash").setAttribute("aria-pressed", String(state.showingTrash));
    if (state.showingTrash) {
      const query = $("voice-search").value.trim().toLowerCase();
      const voices = state.trash.filter((voice) => String(voice.name).toLowerCase().includes(query));
      $("voice-list").innerHTML = state.trashLoading ? `<div class="library-empty">${escapeHtml(t("library.trashLoading"))}</div>` : state.trashError ? `<div class="library-empty"><strong>${escapeHtml(t("library.trashError"))}</strong><button class="text-button" data-trash-retry type="button">${escapeHtml(t("common.retry"))}</button></div>` : !voices.length ? `<div class="library-empty"><strong>${escapeHtml(query ? t("library.noMatch") : t("library.trashEmpty"))}</strong>${escapeHtml(t("library.trashHint"))}</div>` : voices.map((voice) => `<div class="trash-card"><div><strong>${escapeHtml(voice.name)}</strong><small>${escapeHtml(formatDate(voice.deleted_at || voice.updated_at))}</small></div><button class="text-button" type="button" data-restore-id="${escapeHtml(voice.id)}" ${state.restoring.has(String(voice.id)) ? "disabled" : ""}>${state.restoring.has(String(voice.id)) ? t("common.restoring") : t("common.restore")}</button></div>`).join("");
      return;
    }
    if (state.voicesLoading) return;
    const query = $("voice-search").value.trim().toLowerCase();
    const voices = state.voices.filter((voice) => String(voice.name).toLowerCase().includes(query));
    if (!voices.length) {
      $("voice-list").innerHTML = `<div class="library-empty"><strong>${state.voicesError ? t("library.loadError") : query ? t("library.noMatch") : t("library.empty")}</strong>${state.voicesError ? t("library.reconnectHint") : query ? t("library.searchHint") : t("library.emptyHint")}</div>`;
    } else {
      $("voice-list").innerHTML = voices.map((voice) => {
        const selected = String(voice.id) === state.selectedId;
        const label = voice.preset ? t(voice.preset_modified ? "libraryX.modifiedPreset" : "libraryX.preset") : voice.builtin ? t("library.example") : voice.duration_seconds ? t("library.savedDuration", { duration: formatDuration(voice.duration_seconds) }) : t("common.savedVoice");
        return `<div class="voice-card${selected ? " is-selected" : ""}"><button class="voice-select" type="button" data-voice-id="${escapeHtml(voice.id)}" aria-pressed="${selected}" title="${escapeHtml(voice.name)}"><span class="avatar" data-color="${avatarColor(voice.id)}" aria-hidden="true">${avatarContents(voice)}</span><span class="voice-card-copy"><strong>${escapeHtml(voice.name)}</strong><small>${escapeHtml(label)}</small></span>${selected ? `<span class="voice-selected-icon">${icons.check}</span>` : ""}</button></div>`;
      }).join("");
    }
    renderSelection();
  }
  function renderSelection() {
    const voice = selectedVoice();
    $("selected-voice-name").textContent = voice?.name || t("composer.chooseFromLibrary");
    $("selected-voice-edit").disabled = !voice || state.stopped;
    const avatar = $("selected-voice").querySelector(".avatar");
    avatar.innerHTML = avatarContents(voice);
    avatar.dataset.color = voice ? avatarColor(voice.id) : "0";
    updateGenerateButton();
  }
  function updateGenerateButton() {
    const busy = isBusy();
    const ready = state.status.state === "ready" && !state.stopped;
    $("generate-button").disabled = !ready || busy || !!modelIssue() || !!enhancementIssue() || !selectedVoice() || !$("generation-text").value.trim() || state.plan.state !== "ready";
    $("enhance-output").disabled = busy || state.stopped || (!enhancementAvailable() && !$("enhance-output").checked);
    setText("enhance-output-status", enhancementStatusText());
    renderModelControl("generation-model", "generation-model-hint", state.modelId, busy || state.stopped);
    $("generate-button").classList.toggle("is-generating", busy);
    $("generate-icon").innerHTML = busy ? '<span class="spinner" aria-hidden="true"></span>' : generateIcon;
    let label = t("generate.action");
    if (busy) {
      label = t("generate.working");
      if (Number(state.status.chunk_count) > 1) label = t("generate.progressButton", { done: Math.min(Number(state.status.chunk_index) || 0, Number(state.status.chunk_count)), total: state.status.chunk_count });
      else if (Number(state.status.step_count) > 4) label = t("models.stepProgress", { done: Math.min(Number(state.status.step_index) || 0, Number(state.status.step_count)), total: state.status.step_count });
      if (state.status.state === "loading_model") label = t("models.loading", { model: modelName(modelId(state.status.active_model_id)) });
      if (state.status.state === "loading_enhancement") label = t("enhance.loading");
      else if (state.status.state === "enhancing" || state.request?.kind === "enhancement" || state.enhancementJob) label = t("enhance.working");
    } else if (state.stopped) label = t("generate.stopped");
    else if (state.status.state === "loading") label = t("generate.loading");
    else if (state.status.state === "error") label = t("generate.connection");
    else if (state.plan.state === "pending") label = t("generate.planning");
    $("generate-label").textContent = label;
    $("cancel-row").hidden = !(state.request && (state.generating || state.recovering));
    const cancelling = state.cancelPending || state.request?.cancelled || state.status.cancel_requested;
    const differentRequest = nativeBusy() && state.status.request_id && state.status.request_id !== state.request?.id;
    const savingFinishedRequest = state.status.request_id === state.request?.id && state.status.can_cancel === false;
    $("cancel-generation").disabled = cancelling || !state.connected || savingFinishedRequest || !!differentRequest;
    const enhancing = ["loading_enhancement", "enhancing"].includes(state.status.state) || state.request?.kind === "enhancement";
    $("cancel-generation").textContent = cancelling ? t("cancel.requested") : t(enhancing ? "enhance.cancel" : "cancel.action");
    $("cancel-hint").textContent = enhancing ? t("enhance.cancelHint") : state.status.state === "loading_model" ? t("models.loadingCancel") : cancelling ? t("cancel.waitHint") : state.recovering ? t("cancel.recoverHint") : t("cancel.hint");
    if ($("speech-edit-result")) $("speech-edit-result").disabled = !ready || busy || !window.StudioSpeechEdit;
    if ($("enhance-result")) $("enhance-result").disabled = $("enhance-result").hidden || !ready || busy || !enhancementAvailable();
    renderReferenceEnhancement();
    refreshOutputStatus();
  }
  function renderStatus() {
    const versionNode = $("app-version");
    if (versionNode && state.status.display_version) versionNode.textContent = state.status.display_version;
    const current = state.stopped ? "stopped" : state.status.state;
    $("model-status").dataset.state = current;
    $("model-status-text").textContent = { ready: t("status.ready"), loading: t("generate.loading"), loading_model: t("models.loading", { model: modelName(modelId(state.status.active_model_id)) }), loading_enhancement: t("enhance.loading"), enhancing: t("enhance.working"), generating: t("generate.working"), error: t("status.error"), stopped: t("status.stopped") }[current] || t("generate.loading");
    $("model-status").title = state.status.state === "error" ? readableError(new Error(state.status.message || "")) : $("model-status-text").textContent;
    $("connection-notice").hidden = state.stopped || (state.connected && state.status.state !== "error");
    $("connection-message").textContent = state.connected ? readableError(new Error(state.status.message || t("connection.modelFailure"))) : t("connection.notice");
    updateGenerateButton();
    window.StudioSpeechEdit?.refreshModels?.();
    if ((state.generating || state.recovering) && $("generation-progress")) {
      const total = Number(state.status.chunk_count) || 0;
      const completed = Number(state.status.chunk_index) || 0;
      setText("generation-progress", state.status.state === "loading_model" ? t("models.loading", { model: modelName(modelId(state.status.active_model_id)) }) : total > 1 ? t("generate.progress", { done: Math.min(completed, total), total }) : Number(state.status.step_count) > 4 ? t("models.stepProgress", { done: Math.min(Number(state.status.step_index) || 0, Number(state.status.step_count)), total: state.status.step_count }) : t("generate.workingHint"));
      setText("generation-chunk", state.status.chunk_text || "");
      if (["loading_enhancement", "enhancing"].includes(state.status.state) || state.request?.kind === "enhancement") setText("generation-progress", enhancementStatusText());
    }
  }
  async function refreshStatus() {
    if (state.statusPending || state.stopped || state.shuttingDown) return;
    state.statusPending = true;
    try {
      const previous = state.status.state;
      const previousInstance = state.status.instance_id;
      const previousAvailability = JSON.stringify(state.status.models?.map(model => [model.id, model.available]));
      const previousEnhancement = enhancementAvailable();
      const wasConnected = state.connected;
      state.status = await api("/api/status", { timeout: 7000 });
      state.connected = true;
      const restarted = previousInstance && state.status.instance_id && previousInstance !== state.status.instance_id;
      if (restarted) state.renderedResultId = "";
      if (!wasConnected || previous === "error" || restarted) {
        await Promise.allSettled([refreshVoices(), refreshTrash(), refreshHistory()]);
        schedulePlan(0);
      } else if (state.voicesError) await refreshVoices();
      else if (previousAvailability !== JSON.stringify(state.status.models?.map(model => [model.id, model.available])) || previousEnhancement !== enhancementAvailable()) schedulePlan(0);
      if (state.recovering && nativeBusy()) renderWorkingResult();
      if (state.recovering && (state.status.state === "ready" || state.status.state === "error")) {
        const request = state.request;
        const historyReady = await refreshHistory();
        if (!historyReady || state.request !== request) return;
        const { completed: recovered, raw } = recoveryOutputs(request);
        if (recovered) state.activeResultId = String(recovered.id);
        clearPending();
        setError("generation-error");
        renderResults();
        if (!recovered && raw) await keepRawResult(raw);
        else showToast(recovered ? t("connection.foundResult") : request?.cancelled ? t("cancel.done") : t("connection.previousChecked"));
      } else if (nativeBusy(previous) && state.status.state === "ready" && !state.generating) await refreshHistory();
    } catch (error) {
      state.connected = false;
      state.status = { state: "error", message: readableError(error) };
    } finally {
      state.statusPending = false;
      renderStatus();
    }
  }
  async function refreshVoices() {
    const requestId = ++state.voicesRequest;
    try {
      const payload = await api("/api/voices", { timeout: 10000 });
      if (requestId !== state.voicesRequest) return;
      state.voices = (payload.voices || []).map((voice) => ({ ...voice, reference_text: voice.reference_text ?? voice.ref_text ?? "" }));
      updateWarnings("voices", payload.warnings);
      state.voicesError = "";
      if (!selectedVoice()) {
        if (state.selectedId) { state.requireVoiceSelection = true; showToast(t("library.missingSelection")); }
        state.selectedId = !state.requireVoiceSelection && state.voices.length ? String(state.voices[0].id) : "";
      }
      persistDraft();
    } catch (error) { if (requestId === state.voicesRequest) state.voicesError = readableError(error); }
    finally { if (requestId === state.voicesRequest) { state.voicesLoading = false; renderVoices(); renderSelection(); schedulePlan(); } }
  }
  async function refreshTrash() {
    const requestId = ++state.trashRequest;
    state.trashLoading = true;
    try {
      const payload = await api("/api/trash", { timeout: 10000 });
      if (requestId !== state.trashRequest) return;
      state.trash = payload.voices || [];
      state.trashError = "";
      updateWarnings("trash", payload.warnings);
    } catch (error) { if (requestId === state.trashRequest) state.trashError = readableError(error); }
    finally { if (requestId === state.trashRequest) { state.trashLoading = false; renderVoices(); } }
  }
  async function restoreVoice(id) {
    id = String(id);
    if (state.restoring.has(id)) return;
    state.restoring.add(id);
    renderVoices();
    try {
      const payload = await api(`/api/voices/${encodeURIComponent(id)}/restore`, { method: "POST" });
      state.selectedId = String((payload.voice || payload).id);
      state.requireVoiceSelection = false;
      state.showingTrash = false;
      await Promise.allSettled([refreshVoices(), refreshTrash()]);
      showToast(t("library.restored"));
    } catch (error) { showToast(readableError(error), true); }
    finally { state.restoring.delete(id); renderVoices(); }
  }

  function planKey() {
    const draft = currentDraft();
    const voice = selectedVoice();
    return JSON.stringify([draft.model_id, draft.voice_id, voice?.updated_at || "", voice?.duration_seconds || 0, voice?.reference_text || "", draft.text.trim(), draft.duration_mode === "target" ? 1 : draft.speed, draft.split_long_text, draft.duration_mode === "target" ? draft.duration_seconds : 0, draft.enhance_output === true]);
  }
  function durationIssue(draft = currentDraft()) {
    return draft.duration_mode === "target" && (!Number.isFinite(draft.duration_seconds) || draft.duration_seconds < .2 || draft.duration_seconds > 600) ? t("features.durationError") : "";
  }
  function requestSettings(draft = currentDraft()) {
    return { model_id: modelId(draft.model_id), speed: draft.duration_mode === "target" ? 1 : draft.speed, split_long_text: draft.split_long_text, enhance_output: draft.enhance_output === true, ...(draft.duration_mode === "target" ? { duration_seconds: draft.duration_seconds } : {}) };
  }
  function newRandomSeed() {
    const value = crypto.getRandomValues(new Uint32Array(1))[0];
    $("seed").value = String(value);
    return value;
  }
  function onSeedChanged() { renderDraftLabels(); persistDraft(); }
  function randomizeSeed() {
    const seed = newRandomSeed();
    onSeedChanged();
    showToast(t("features.seedRandomized", { seed }));
  }
  function schedulePlan(delay = 400) {
    clearTimeout(state.planTimer);
    const revision = ++state.planRevision;
    const key = planKey();
    const text = $("generation-text").value.trim();
    const textError = textIssue(text, 5000, t("validation.generationLabel"));
    const durationError = durationIssue();
    const issue = modelIssue() || enhancementIssue() || textError || durationError;
    $("generation-text").setAttribute("aria-invalid", String(!!textError));
    $("duration-seconds").setAttribute("aria-invalid", String(!!durationError));
    if (issue) {
      state.plan = { state: "invalid", key };
      setError("generation-error", issue);
      setText("plan-status", t("plan.invalid"));
    } else if (!text || !selectedVoice()) {
      state.plan = { state: "empty", key };
      setError("generation-error");
      setText("plan-status", !selectedVoice() ? t("plan.chooseVoice") : t("plan.empty"));
    } else if (state.plan.state === "ready" && state.plan.key === key) { updateGenerateButton(); return; }
    else {
      state.plan = { state: "pending", key };
      setError("generation-error");
      setText("plan-status", t("plan.loading"));
      state.planTimer = setTimeout(() => loadPlan(key, revision), delay);
    }
    $("plan-preview").hidden = true;
    $("plan-retry").hidden = true;
    updateGenerateButton();
  }
  async function loadPlan(key, revision) {
    const draft = currentDraft();
    try {
      const plan = await api("/api/plan", { method: "POST", json: { voice_id: draft.voice_id, text: draft.text.trim(), ...requestSettings(draft) }, timeout: 15000 });
      if (revision !== state.planRevision || key !== planKey()) return;
      state.plan = { state: "ready", key, value: plan };
      const count = Number(plan.segment_count || plan.segments?.length || 1);
      setText("plan-status", t(count > 1 ? "plan.summaryMany" : "plan.summaryOne", { duration: formatDuration(plan.duration_seconds), count }));
      $("plan-count").textContent = `(${count})`;
      $("plan-segments").innerHTML = (plan.segments || []).map((segment, index) => `<li><span class="segment-label">${index + 1} · ${escapeHtml(formatDuration(segment.duration_seconds))}</span><p>${escapeHtml(segment.text)}</p></li>`).join("");
      $("plan-preview").hidden = !(plan.segments || []).length;
      $("plan-retry").hidden = true;
    } catch (error) {
      if (revision !== state.planRevision || key !== planKey()) return;
      state.plan = { state: "error", key, error };
      setText("plan-status", readableError(error));
      $("plan-retry").hidden = false;
    } finally { if (revision === state.planRevision) updateGenerateButton(); }
  }
  async function refreshHistory(preferredId) {
    const requestId = ++state.historyRequest;
    const query = state.historyQuery.trim();
    const queryIssue = historyQueryIssue(query);
    try {
      // Recovery always sees the latest jobs, even while the user searches old recordings.
      const [recent, filtered, recovered, source] = await Promise.all([
        api("/api/history?limit=60", { timeout: 10000 }),
        queryIssue ? Promise.resolve({ items: [], total: 0, has_more: false }) : query ? api(`/api/history?limit=60&q=${encodeURIComponent(query)}`, { timeout: 10000 }) : Promise.resolve(null),
        state.request?.id ? api(`/api/history?limit=60&q=${encodeURIComponent(state.request.id)}`, { timeout: 10000 }) : Promise.resolve(null),
        state.request?.source_id ? api(`/api/history?limit=60&q=${encodeURIComponent(state.request.source_id)}`, { timeout: 10000 }) : Promise.resolve(null),
      ]);
      if (requestId !== state.historyRequest) return false;
      const payload = filtered || recent;
      mergeHistory([...(recent.items || []), ...(filtered?.items || []), ...(recovered?.items || []), ...(source?.items || [])]);
      state.historyPageIds = Number.isInteger(payload.total) ? (payload.items || []).map(item => String(item.id)) : null;
      state.historyCursor = payload.next_cursor || null;
      state.historyHasMore = payload.has_more === true;
      state.historyTotal = Number.isInteger(payload.total) ? payload.total : null;
      state.historyError = queryIssue;
      updateWarnings("history", recent.warnings);
      if (preferredId) state.activeResultId = String(preferredId);
      if (!state.history.some((item) => String(item.id) === state.activeResultId)) state.activeResultId = state.history.length ? String(state.history[0].id) : "";
      return true;
    } catch (error) {
      if (requestId === state.historyRequest) state.historyError = t("history.loadError");
      return false;
    } finally {
      if (requestId === state.historyRequest) {
        state.historyLoading = false;
        state.historyMoreLoading = false;
        if (!state.generating && !state.recovering) renderResults(); else renderHistory();
      }
    }
  }
  function mergeHistory(items) {
    const known = new Map(state.history.map(item => [String(item.id), item]));
    for (const item of items) { known.set(String(item.id), item); state.unsavedResults.delete(String(item.id)); }
    for (const [id, item] of state.unsavedResults) known.set(id, item);
    state.history = [...known.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)));
  }
  function historyGroups() {
    const query = state.historyQuery.toLowerCase().trim();
    const ids = state.historyPageIds && new Set(state.historyPageIds);
    const items = state.history.filter(item => ids ? ids.has(String(item.id)) || (!query && state.unsavedResults.has(String(item.id))) : `${item.text} ${item.voice_name} ${modelResultLabel(item)}`.toLowerCase().includes(query));
    const originals = new Set(items.filter(item => item.enhanced && item.source_id).map(item => String(item.source_id)));
    return items.filter(item => !originals.has(String(item.id)));
  }
  async function loadMoreHistory() {
    if (state.historyMoreLoading || state.historyLoading) return;
    const visible = historyGroups().length;
    if (state.historyLimit < visible) { state.historyLimit += 12; renderHistory(); return; }
    if (!state.historyHasMore || !state.historyCursor) return;
    const requestId = ++state.historyRequest, query = state.historyQuery.trim();
    state.historyMoreLoading = true; state.historyError = ""; renderHistory();
    try {
      const payload = await api(`/api/history?limit=60&q=${encodeURIComponent(query)}&cursor=${encodeURIComponent(state.historyCursor)}`, { timeout: 10000 });
      if (requestId !== state.historyRequest) return;
      mergeHistory(payload.items || []);
      state.historyPageIds = [...new Set([...(state.historyPageIds || []), ...(payload.items || []).map(item => String(item.id))])];
      state.historyCursor = payload.next_cursor || null; state.historyHasMore = payload.has_more === true;
      state.historyTotal = Number.isInteger(payload.total) ? payload.total : state.historyTotal;
      state.historyLimit += 12;
    } catch { if (requestId === state.historyRequest) state.historyError = t("uxHistory.moreFailed"); }
    finally { if (requestId === state.historyRequest) { state.historyMoreLoading = false; renderHistory(); } }
  }
  function searchHistory() {
    state.historyQuery = $("history-search").value; state.historyLimit = 12;
    state.historyRequest++; state.historyLoading = true; state.historyMoreLoading = false;
    state.historyPageIds = []; state.historyHasMore = false; state.historyError = "";
    state.historyError = historyQueryIssue(state.historyQuery.trim());
    if (state.historyError) state.historyLoading = false;
    clearTimeout(state.historySearchTimer); renderHistory();
    if (!state.historyError) state.historySearchTimer = setTimeout(() => refreshHistory(), 250);
  }
  function historyQueryIssue(query) { return new TextEncoder().encode(query).length > 512 ? t("uxHistory.queryLong") : ""; }
  function downloadName(item) {
    const name = String(item.voice_name || "WaveGen").replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    const snippet = String(item.text || t("common.audio")).replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48);
    const date = String(item.created_at || "").slice(0, 10).replace(/[^0-9-]/g, "");
    return `${name || "WaveGen"} - ${snippet || t("common.audio")}${date ? ` - ${date}` : ""}.wav`;
  }
  function renderResults() {
    renderHistory();
    refreshOutputStatus();
    const active = state.history.find((item) => String(item.id) === state.activeResultId);
    if (!active) {
      $("result-player").innerHTML = `<div class="result-empty"><div class="empty-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><h3>${escapeHtml(t("result.emptyTitle"))}</h3><p>${escapeHtml(t("result.emptyHint"))}</p></div>`;
      state.renderedResultId = "";
      return;
    }
    if (state.renderedResultId === String(active.id) && $("generated-player")) { refreshResultLabels(active); return; }
    state.renderedResultId = String(active.id);
    const audioUrl = safeAudioUrl(active.audio_url);
    $("result-player").innerHTML = `<div class="audio-result">
      <div class="result-meta"><span class="result-voice-label">${icons.voice}<span id="result-voice-name">${escapeHtml(active.voice_name || t("common.savedVoice"))}</span></span><time class="result-time" id="result-date"></time></div>
      <div class="result-controls"><audio id="generated-player" controls preload="metadata" src="${escapeHtml(audioUrl)}"></audio><a id="result-download" class="download-button" href="${escapeHtml(audioUrl)}" download="${escapeHtml(downloadName(active))}">${icons.download}</a></div>
      <div class="result-bottom"><span id="result-duration"></span><span id="result-timing"></span></div>
      <p id="result-transcript-notice" class="result-transcript-notice" hidden></p>
      <div class="result-actions"><div class="result-action-buttons"><button class="button button-outline" id="speech-edit-result" type="button"></button><button class="button button-outline" id="reuse-result" type="button"></button><button class="button button-outline" id="enhance-result" type="button"></button></div></div>
      <p class="result-enhancement-note enhancement-status" id="result-enhancement-status"></p>
      <details class="result-details" id="result-details"><summary id="result-details-label"></summary><p class="result-text">${escapeHtml(active.text)}</p><p class="result-settings" id="result-settings"></p><p id="result-reuse-hint" class="result-reuse-hint"></p></details>
      <details class="result-comparison" id="result-enhancement-comparison" hidden><summary id="result-comparison-label"></summary><div class="enhancement-comparison"><label><span id="result-before-label"></span><audio id="result-before-player" aria-labelledby="result-before-label" controls preload="metadata"></audio></label><label><span id="result-after-label"></span><audio id="result-after-player" aria-labelledby="result-after-label" controls preload="metadata"></audio></label><p id="result-comparison-hint"></p></div></details>
      ${active.warning ? '<p id="result-save-warning" class="inline-error"></p>' : ""}</div>`;
    const originalUrl = safeAudioUrl(active.original_audio_url || state.history.find(item => String(item.id) === String(active.source_id))?.audio_url);
    if (active.enhanced && originalUrl) {
      $("result-before-player").src = originalUrl;
      $("result-after-player").src = audioUrl;
      $("result-enhancement-comparison").hidden = false;
    }
    refreshResultLabels(active);
    $("enhance-result").addEventListener("click", () => enhanceExistingResult(active));
    $("reuse-result").addEventListener("click", () => reuseResult(active));
    $("speech-edit-result").addEventListener("click", () => { if (!isBusy() && !state.stopped) window.StudioSpeechEdit?.open(active); });
    const comparison = $("result-enhancement-comparison"), mainPlayer = $("generated-player"), beforePlayer = $("result-before-player"), afterPlayer = $("result-after-player");
    comparison.addEventListener("toggle", () => {
      if (comparison.isConnected === false) return;
      if (comparison.open) mainPlayer.pause();
      else { beforePlayer.pause(); afterPlayer.pause(); }
    });
  }
  function legacyCharacterResultLabel(item) {
    // Old recordings keep their provenance after the optional candidate library is removed.
    if (!item?.character_effect && !item?.source_character_effect && !item?.derived_from_character) return "";
    const scope = item.character_effect_scope || item.character_effect?.scope;
    const key = !item.character_effect ? "output.characterMixed" : scope === "inherited" ? "output.characterInherited" : scope === "replacement" || scope === "regenerated_section" ? "output.characterReplacement" : "output.characterFull";
    return [t(key), item.character_effect_may_be_softened ? t("output.characterSoftened") : ""].filter(Boolean).join(" · ");
  }
  function refreshResultLabels(active) {
    // Updating labels in place preserves playback position, buffered audio, and focus.
    const count = Number(active.segments_count ?? active.segment_count ?? active.segments?.length ?? 1);
    const seconds = Number(active.generation_seconds ?? active.synthesis_seconds);
    setText("result-voice-name", active.voice_name || t("common.savedVoice"));
    setText("result-date", formatDate(active.created_at));
    setText("result-duration", [formatDuration(active.duration_seconds), count > 1 ? t("result.joined", { count }) : ""].filter(Boolean).join(" · "));
    setText("result-timing", Number.isFinite(seconds) ? t("result.generatedIn", { seconds: seconds.toFixed(2) }) : "");
    setText("reuse-result", t("result.reuse"));
    setText("result-reuse-hint", t("result.reuseHint"));
    setText("speech-edit-result", t("features.speechEdit"));
    setText("result-details-label", t("output.details"));
    setText("result-comparison-label", t("output.compare"));
    $("speech-edit-result").disabled = state.stopped || isBusy() || state.status.state !== "ready" || !window.StudioSpeechEdit;
    setText("enhance-result", t("enhance.existingAction"));
    $("enhance-result").hidden = active.enhanced === true;
    $("enhance-result").disabled = active.enhanced === true || state.stopped || isBusy() || state.status.state !== "ready" || !enhancementAvailable();
    setText("result-before-label", t("enhance.before")); setText("result-after-label", t("enhance.after"));
    setText("result-comparison-hint", t("enhance.compareHint"));
    setText("result-enhancement-status", active.enhanced ? t($("result-enhancement-comparison").hidden ? "enhance.originalMissing" : "enhance.badge") : enhancementStatusText());
    const settings = [modelResultLabel(active)];
    const characterLabel = legacyCharacterResultLabel(active);
    if (characterLabel) settings.push(characterLabel);
    if (active.enhanced) settings.push(t("enhance.badge"));
    if (Number.isInteger(Number(active.seed))) settings.push(t("features.resultSeed", { seed: active.seed }));
    if (active.duration_mode === "fixed" && Number(active.requested_duration_seconds) > 0) settings.push(t("features.durationChip", { seconds: Number(active.requested_duration_seconds).toFixed(2) }));
    setText("result-settings", settings.join(" · "));
    $("result-settings").hidden = !settings.length;
    setText("result-transcript-notice", t("features.editedTranscript"));
    $("result-transcript-notice").hidden = !active.transcript_stale;
    $("generated-player").setAttribute("aria-label", t("result.playAria"));
    $("result-download").setAttribute("aria-label", t("result.downloadAria"));
    $("result-download").title = t("result.downloadTitle");
    if (active.warning) setText("result-save-warning", t("result.saveWarning", { details: i18n.translate(active.warning) }));
  }
  function renderHistory() {
    setError("history-error", state.historyError);
    $("history-search").setAttribute("aria-invalid", String(!!historyQueryIssue(state.historyQuery.trim())));
    $("history-search").setAttribute("aria-describedby", "history-error");
    const count = state.historyTotal ?? state.history.length;
    $("results-count").textContent = state.historyLoading ? t("history.loading") : count ? t(count === 1 ? "history.countOne" : "history.countMany", { count }) : state.historyError ? t("history.connection") : t("history.empty");
    const items = historyGroups();
    $("history-list").innerHTML = items.slice(0, state.historyLimit).map((item) => {
      const original = item.enhanced && state.history.find(source => String(source.id) === String(item.source_id));
      const row = `<button class="history-item${String(item.id) === state.activeResultId ? " is-active" : ""}" type="button" data-result-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(t("history.playAria", { voice: item.voice_name || t("common.voice"), text: item.text }))}"><span class="history-play" aria-hidden="true">${icons.play}</span><span class="history-copy"><strong>${escapeHtml(item.text)}</strong><small><span>${escapeHtml(item.voice_name || t("common.voice"))}</span><span class="history-model">${escapeHtml(modelResultLabel(item))}</span>${item.enhanced ? `<span class="enhancement-badge">${escapeHtml(t("enhance.badge"))}</span>` : ""}<span>${escapeHtml(formatDate(item.created_at))}</span></small></span><span class="history-duration">${escapeHtml(formatDuration(item.duration_seconds))}</span></button>`;
      return original ? `<div class="history-group">${row}<div class="history-versions"><span>${escapeHtml(t("uxHistory.versions"))}</span><button class="text-button${String(original.id) === state.activeResultId ? " is-active" : ""}" type="button" data-result-id="${escapeHtml(original.id)}" aria-pressed="${String(original.id) === state.activeResultId}">${escapeHtml(t("uxHistory.original"))}</button></div></div>` : row;
    }).join("") || (state.historyLoading ? `<p class="history-empty" role="status">${escapeHtml(t("history.loading"))}</p>` : state.historyQuery.trim() && !state.historyError ? `<p class="history-empty">${escapeHtml(t("history.noMatch"))}</p>` : "");
    $("history-more").hidden = !state.historyMoreLoading && !state.historyHasMore && items.length <= state.historyLimit;
    $("history-more").disabled = state.historyMoreLoading || state.historyLoading;
    $("history-more").textContent = t(state.historyMoreLoading ? "uxHistory.loadingMore" : "history.more");
  }
  function applyDraft(draft) {
    state.modelId = modelId(draft.model_id);
    $("generation-text").value = String(draft.text || "").slice(0, 5000);
    $("speed").value = Number.isFinite(Number(draft.speed)) ? Math.max(.5, Math.min(2, Number(draft.speed))) : 1;
    $("seed").value = Number.isInteger(Number(draft.seed)) && Number(draft.seed) >= 0 && Number(draft.seed) <= 4294967295 ? Number(draft.seed) : 0;
    $("seed-every-time").checked = draft.randomize_seed === true;
    $("duration-mode").value = ["target", "fixed"].includes(draft.duration_mode) ? "target" : "auto";
    const duration = Number(draft.duration_mode === "fixed" ? draft.requested_duration_seconds : draft.duration_seconds);
    $("duration-seconds").value = Number.isFinite(duration) && duration >= .2 && duration <= 600 ? duration : 10;
    $("split-long-text").checked = draft.split_long_text !== false;
    $("enhance-output").checked = draft.enhance_output === true;
    const voice = state.voices.find((item) => String(item.id) === String(draft.voice_id));
    state.selectedId = voice ? String(voice.id) : "";
    state.requireVoiceSelection = !voice;
    onDraftChanged();
    renderVoices();
    renderSelection();
    return !!voice;
  }
  function reuseResult(item) {
    if (isBusy() || state.stopped) return showToast(t("generate.otherBusy"), true);
    const previous = currentDraft();
    const hasVoice = applyDraft({ ...item, randomize_seed: false });
    $("generation-text").focus();
    $("generation-text").scrollIntoView({ block: "center", behavior: "smooth" });
    const notice = [hasVoice ? t("result.reused") : t("result.reusedMissingVoice"), item.transcript_stale ? t("features.editedReuseWarning") : ""].filter(Boolean);
    showToast(notice, false, { label: t("common.undo"), run: () => { if (isBusy() || state.stopped) return showToast(t("generate.otherBusy"), true); applyDraft(previous); showToast(t("result.undoDraft")); } });
  }
  function renderWorkingResult() {
    state.renderedResultId = "";
    refreshOutputStatus();
    if ($("generation-progress")) { setText("generation-working-title", t("generate.workingTitle")); return; }
    $("result-player").innerHTML = `<div class="result-empty is-working" role="status" aria-live="polite"><div class="empty-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><h3 id="generation-working-title">${escapeHtml(t("generate.workingTitle"))}</h3><p id="generation-progress">${escapeHtml(t("generate.workingHint"))}</p><p id="generation-chunk" class="generation-chunk"></p></div>`;
  }
  function refreshOutputStatus() {
    const working = state.generating || state.recovering;
    const available = state.history.some(item => String(item.id) === state.activeResultId);
    const label = working ? t(state.recovering ? "generate.recovering" : "generate.working") : available ? t("output.ready") : "";
    const status = $("output-status");
    if (status.textContent !== label) status.textContent = label;
    status.dataset.state = working ? "working" : available ? "ready" : "empty";
    $("show-output").hidden = !working && !available;
    setText("show-output", t("output.view"));
  }
  async function generate() {
    if (isBusy() || state.stopped) return;
    const voice = selectedVoice();
    const text = $("generation-text").value.trim();
    setError("generation-error");
    if (!voice) return setError("generation-error", t("error.chooseVoice"));
    if (!text) return $("generation-text").focus();
    const issue = modelIssue() || enhancementIssue() || textIssue(text, 5000, t("validation.generationLabel")) || durationIssue();
    if (issue) return setError("generation-error", issue);
    if (state.plan.state !== "ready" || state.plan.key !== planKey()) { schedulePlan(0); return; }
    const seed = $("seed-every-time").checked ? newRandomSeed() : Number($("seed").value || 0);
    const settings = requestSettings();
    const speed = settings.speed;
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) return setError("generation-error", t("error.seed"));
    if (!Number.isFinite(speed) || speed < .5 || speed > 2) return setError("generation-error", t("error.speed"));
    onSeedChanged();
    state.generating = true;
    const id = newRequestId();
    state.request = { id, draft: currentDraft(), started_at: new Date().toISOString(), cancelled: false };
    storePending(state.request);
    updateGenerateButton();
    renderWorkingResult();
    scheduleStatusPoll(0);
    try {
      const result = await api("/api/generate", { method: "POST", json: { voice_id: voice.id, text, seed, ...settings, request_id: id } });
      if (result.raw_result && (result.cancelled || result.enhancement_failed)) { await keepRawResult(result.raw_result); return; }
      if (result.cancelled) { showToast(t("cancel.done")); return; }
      const item = result.result || result;
      state.activeResultId = String(item.id);
      state.history = [item, ...state.history.filter((previous) => String(previous.id) !== String(item.id))];
      if (item.history_saved === false) state.unsavedResults.set(String(item.id), item);
      if (item.warning) updateWarnings("save", item.warning);
      showToast(item.warning ? t("generate.completeWarning") : t("generate.complete"), !!item.warning);
      await refreshHistory(item.id);
    } catch (error) {
      if (error.payload?.raw_result) { await keepRawResult(error.payload.raw_result); return; }
      if (!error.status) {
        await refreshStatus();
        const historyReady = await refreshHistory();
        const { completed, raw } = recoveryOutputs(state.request);
        if (!historyReady || !state.connected || state.status.request_id === id) {
          state.recovering = true;
          setError("generation-error", t("generate.recovering"));
        } else if (completed) { state.activeResultId = String(completed.id); showToast(t("generate.recovered")); }
        else if (raw) await keepRawResult(raw);
        else setError("generation-error", readableError(error));
      } else setError("generation-error", error.status === 409 ? t("generate.otherBusy") : readableError(error));
    } finally {
      state.generating = false;
      if (!state.recovering) { clearPending(); renderResults(); }
      await refreshStatus();
      updateGenerateButton();
      scheduleStatusPoll();
    }
  }
  async function cancelGeneration() {
    if (!state.request || state.cancelPending || state.request.cancelled) return;
    const requestId = state.request.id;
    state.cancelPending = true;
    updateGenerateButton();
    try {
      await api("/api/cancel", { method: "POST", json: { request_id: requestId } });
      if (state.request?.id === requestId) { state.request.cancelled = true; storePending(state.request); }
      if (state.request?.id === requestId) showToast(t("cancel.toast"));
    } catch (error) {
      if (state.request?.id === requestId) showToast(error.status === 409 ? t("cancel.finished") : readableError(error), error.status !== 409);
    } finally { if (state.request?.id === requestId) state.cancelPending = false; updateGenerateButton(); await refreshStatus(); }
  }
  function scheduleStatusPoll(delay) {
    clearTimeout(state.pollTimer);
    if (state.stopped) return;
    state.pollTimer = setTimeout(async () => { await refreshStatus(); scheduleStatusPoll(); }, delay ?? (isBusy() ? 250 : 2500));
  }

  async function keepRawResult(item) {
    state.activeResultId = String(item.id);
    state.history = [item, ...state.history.filter(previous => String(previous.id) !== String(item.id))];
    if (item.history_saved === false) state.unsavedResults.set(String(item.id), item);
    await refreshHistory(item.id);
    showToast(t("enhance.rawSaved"));
    setError("generation-error", t("enhance.rawSaved"));
  }
  async function enhanceExistingResult(source) {
    if (isBusy() || state.stopped || source.enhanced) return;
    if (!enhancementAvailable()) return setError("generation-error", t("enhance.unavailable"));
    const id = newRequestId();
    state.generating = true;
    state.request = { id, kind: "enhancement", source_id: source.id, draft: currentDraft(), started_at: new Date().toISOString(), cancelled: false };
    storePending(state.request); setError("generation-error"); updateGenerateButton(); renderWorkingResult(); scheduleStatusPoll(0);
    try {
      const result = await api("/api/enhance", { method: "POST", json: { source_id: source.id, request_id: id } });
      if (result.cancelled || result.enhancement_failed) {
        if (result.raw_result) await keepRawResult(result.raw_result);
        else { state.activeResultId = String(source.id); showToast(t("enhance.cancelled")); }
        return;
      }
      const item = result.result || result;
      state.history = [item, ...state.history.filter(previous => String(previous.id) !== String(item.id))];
      state.activeResultId = String(item.id);
      if (item.history_saved === false) state.unsavedResults.set(String(item.id), item);
      if (item.warning) updateWarnings("save", item.warning);
      await refreshHistory(item.id); showToast(t("enhance.complete"));
    } catch (error) {
      if (error.payload?.raw_result) await keepRawResult(error.payload.raw_result);
      else if (!error.status) {
        await refreshStatus(); const historyReady = await refreshHistory();
        const { completed: recovered } = recoveryOutputs(state.request);
        if (!historyReady || !state.connected || state.status.request_id === id) { state.recovering = true; setError("generation-error", t("generate.recovering")); }
        else if (recovered) { state.activeResultId = String(recovered.id); showToast(t("enhance.complete")); }
        else { state.activeResultId = String(source.id); setError("generation-error", t("enhance.failed", { details: readableError(error) })); }
      } else { state.activeResultId = String(source.id); setError("generation-error", t("enhance.failed", { details: readableError(error) })); }
    } finally {
      state.generating = false;
      if (!state.recovering) { clearPending(); renderResults(); }
      await refreshStatus(); updateGenerateButton(); scheduleStatusPoll();
    }
  }
  function resetComparisonPlayer(id) {
    const player = $(id); if (!player) return;
    player.pause(); player.removeAttribute("src"); player.load();
  }
  function invalidateReferenceEnhancement(draft, showNotice = false) {
    if (!draft) return;
    const hadEnhancement = !!draft.enhancementPreview || !!draft.voice?.prompt_enhancement?.enabled;
    draft.enhancementRevision = (draft.enhancementRevision || 0) + 1;
    if (draft.promptEnhancementApplied) {
      draft.audioDirty = draft.enhancementPreview?.wasAudioDirty || false;
      if (state.modal === draft) {
        $("reference-player").pause(); $("reference-player").src = draft.previewUrl || safeAudioUrl(draft.voice?.audio_url); $("reference-player").load();
        setText("reference-preview-heading", t(draft.audioDirty ? "referenceX.prepared" : "referenceX.savedPreview"));
      }
    }
    draft.enhancementPreview = null; draft.promptEnhancementApplied = false; draft.enhancementError = "";
    draft.enhancementStale = showNotice && (hadEnhancement || draft.enhancementStale === true);
    draft.enhancementNotice = draft.enhancementStale ? t("enhance.stale") : "";
    resetComparisonPlayer("reference-before-player"); resetComparisonPlayer("reference-after-player");
    if (state.modal === draft) renderReferenceEnhancement();
  }
  function renderReferenceEnhancement() {
    const draft = state.modal; if (!draft || !$("reference-enhance")) return;
    const job = state.enhancementJob?.draft === draft ? state.enhancementJob : null;
    const preview = draft.enhancementPreview;
    const lock = state.saving || !!draft.converting || isBusy() || state.stopped;
    $("reference-enhance").disabled = lock || draft.promptEnhancementApplied || !draft.original || !!draft.audioError || !enhancementAvailable();
    setText("reference-enhance", t(draft.enhancementError ? "enhance.retry" : "enhance.referenceAction"));
    $("reference-enhance-cancel").hidden = !job;
    $("reference-enhance-cancel").disabled = !!job?.cancelPending || !!job?.cancelled || !state.connected || (state.status.request_id === job?.id && state.status.can_cancel === false);
    setText("reference-enhance-cancel", t(job?.cancelPending || job?.cancelled ? "cancel.requested" : "enhance.cancel"));
    $("reference-enhancement-comparison").hidden = !preview;
    $("reference-enhance-apply").disabled = lock || !preview || !!draft.audioError || draft.promptEnhancementApplied;
    $("reference-enhance-discard").disabled = lock || !preview;
    $("reference-enhancement-badge").hidden = !(draft.promptEnhancementApplied || (!draft.audioDirty && draft.voice?.prompt_enhancement?.enabled));
    const status = job ? (job.cancelPending || job.cancelled ? t("enhance.cancelHint") : state.status.state === "loading_enhancement" ? t("enhance.loading") : t("enhance.working")) : draft.promptEnhancementApplied ? t("enhance.applied") : preview ? t("uxVoice.pendingEnhancement") : draft.enhancementNotice || (!draft.original ? t("enhance.openReference") : enhancementStatusText());
    setText("reference-enhancement-status", status);
    setError("reference-enhancement-error", draft.enhancementError || "");
  }
  async function enhanceReference() {
    const draft = state.modal;
    if (!draft?.original || draft.promptEnhancementApplied || isBusy() || state.saving || draft.converting || draft.audioError || state.stopped) return;
    if (!enhancementAvailable()) { draft.enhancementError = t("enhance.unavailable"); renderReferenceEnhancement(); return; }
    $("voice-enhancement-options").open = true;
    invalidateReferenceEnhancement(draft);
    const revision = draft.enhancementRevision, sourceRevision = draft.revision;
    const job = { id: newRequestId(), draft, revision, cancelPending: false, cancelled: false };
    state.enhancementJob = job;
    renderReferenceEnhancement(); updateSaveButton(); updateGenerateButton(); scheduleStatusPoll(0);
    try {
      const processed = window.StudioReferenceEditor.processAudio(draft.original, draft.referenceSettings, trimSamples, SAMPLE_RATE);
      if (processed.samples.length / SAMPLE_RATE >= MAX_REFERENCE_SECONDS) throw new Error(t("referenceX.long"));
      const prepared = draft.file || new File([encodePcmWav(processed.samples)], "reference.wav", { type: "audio/wav" });
      const form = new FormData(); form.append("audio", prepared, "reference.wav"); form.append("request_id", job.id);
      const result = await api("/api/enhance/reference", { method: "POST", body: form });
      if (state.modal !== draft || draft.enhancementRevision !== revision || draft.revision !== sourceRevision) return;
      if (result.cancelled) { draft.enhancementNotice = t("enhance.cancelled"); return; }
      const audioUrl = safeAudioUrl(result.audio_url), beforeUrl = safeAudioUrl(result.input_audio_url);
      if (!audioUrl || !beforeUrl || !result.id || result.sample_rate !== SAMPLE_RATE || result.samples !== processed.samples.length) throw new Error(t("enhance.previewInvalid"));
      const response = await authenticatedFetch(audioUrl);
      if (!response.ok) throw new Error(t("enhance.previewInvalid"));
      const blob = await response.blob();
      if (blob.size < 44) throw new Error(t("enhance.previewInvalid"));
      if (state.modal !== draft || draft.enhancementRevision !== revision || draft.revision !== sourceRevision) return;
      // Forward these exact server-verified bytes on save; never decode/re-encode the token-bound WAV.
      draft.enhancementPreview = { id: result.id, audioUrl, beforeUrl, file: new File([blob], "reference-enhanced.wav", { type: "audio/wav" }), trim: processed, wasAudioDirty: draft.audioDirty };
      $("reference-before-player").src = beforeUrl; $("reference-after-player").src = audioUrl;
      draft.enhancementError = "";
    } catch (error) {
      if (state.modal === draft && draft.enhancementRevision === revision && draft.revision === sourceRevision) draft.enhancementError = t("enhance.failed", { details: readableError(error) });
    } finally {
      if (state.enhancementJob === job) state.enhancementJob = null;
      // A different editor may have opened while cancellation was settling.
      // Release its controls too; the shared job lock no longer exists.
      updateSaveButton();
      await refreshStatus(); updateGenerateButton(); scheduleStatusPoll();
    }
  }
  async function cancelReferenceEnhancement() {
    const job = state.enhancementJob;
    if (!job || job.cancelPending || job.cancelled) return;
    job.cancelPending = true; renderReferenceEnhancement();
    try {
      await api("/api/cancel", { method: "POST", json: { request_id: job.id } });
      if (state.enhancementJob === job) job.cancelled = true;
    } catch (error) {
      if (state.enhancementJob === job && state.modal === job.draft) job.draft.enhancementError = readableError(error);
    } finally { job.cancelPending = false; renderReferenceEnhancement(); }
  }
  function applyReferenceEnhancement() {
    const draft = state.modal, preview = draft?.enhancementPreview;
    if (!preview || isBusy() || state.saving || draft.audioError) return;
    draft.promptEnhancementApplied = true; draft.audioDirty = true;
    requireTranscriptCheck(draft);
    $("reference-player").pause(); $("reference-player").src = preview.audioUrl; $("reference-player").load();
    setText("reference-preview-heading", t("enhance.after"));
    renderReferenceEnhancement(); updateSaveButton();
  }
  function discardReferenceEnhancement() {
    const draft = state.modal;
    if (!draft || isBusy() || state.saving) return;
    const wasApplied = draft.promptEnhancementApplied;
    invalidateReferenceEnhancement(draft);
    if (wasApplied) {
      $("reference-player").pause(); $("reference-player").src = draft.previewUrl || safeAudioUrl(draft.voice?.audio_url); $("reference-player").load();
      requireTranscriptCheck(draft);
    }
    refreshVoiceLabels();
    updateSaveButton();
  }

  function releasePreview(draft) {
    if (draft?.previewUrl) URL.revokeObjectURL(draft.previewUrl);
    if (draft) draft.previewUrl = "";
  }
  function releaseAvatarPreview(draft) {
    if (draft?.avatarPreviewUrl) URL.revokeObjectURL(draft.avatarPreviewUrl);
    if (draft) draft.avatarPreviewUrl = "";
  }
  function renderAvatarEditor() {
    const draft = state.modal;
    if (!draft) return;
    const url = draft.avatarRemove ? "" : draft.avatarPreviewUrl || safeAudioUrl(draft.voice?.avatar_url);
    $("avatar-preview").innerHTML = `<span class="avatar-initials">${escapeHtml(avatarName($("voice-name").value || draft.voice?.name || "W"))}</span>${url ? `<img data-voice-avatar src="${escapeHtml(url)}" alt="">` : ""}`;
    $("avatar-preview").dataset.color = avatarColor(draft.voice?.id || "new");
    setText("avatar-choose", t(url ? "libraryX.replaceImage" : "libraryX.chooseImage"));
    setText("avatar-status", draft.avatarConverting ? t("libraryX.imageProcessing") : draft.avatarRemove ? t("libraryX.imageRemoved") : draft.avatarFile ? t("libraryX.imageReady") : "");
    $("avatar-remove").hidden = !url;
    $("avatar-reset").hidden = !draft.avatarDirty && !draft.avatarError && !draft.avatarConverting;
    $("avatar-dropzone").classList.toggle("is-converting", !!draft.avatarConverting);
    setError("avatar-error", draft.avatarError || "");
    if (draft.avatarError) $("voice-avatar-options").open = true;
  }
  function renderVoiceSource() {
    const voice = state.modal?.voice, source = voice?.source || {}, license = voice?.license || {};
    $("voice-source").hidden = !voice || !(voice.preset || Object.keys(source).length || Object.keys(license).length);
    const text = value => typeof value === "string" ? value : "";
    const sourceUrl = safeSourceUrl(source.url), licenseUrl = safeSourceUrl(license.url);
    const title = text(source.title || source.dataset), attribution = text(source.attribution || license.attribution);
    const licenseName = text(license.title || license.name || license.id);
    const wasOpen = !!$("voice-license-details")?.open;
    $("voice-source-content").innerHTML = `${title ? `<p class="source-name">${escapeHtml(title)}</p>` : ""}${licenseName ? `<p>${escapeHtml(licenseName)}</p>` : ""}<div class="source-links">${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("libraryX.sourceLink"))} ↗</a>` : ""}${licenseUrl ? `<a href="${escapeHtml(licenseUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("libraryX.licenseLink"))} ↗</a>` : ""}</div>${attribution ? `<p class="source-attribution"><strong>${escapeHtml(t("libraryX.attribution"))}</strong><span>${escapeHtml(attribution)}</span></p>` : ""}${text(source.notes) ? `<p>${escapeHtml(source.notes)}</p>` : ""}${source.fictional_character || voice?.preset ? `<p>${escapeHtml(t("libraryX.fictional"))}</p>` : ""}${voice?.preset_modified ? `<p class="source-modified">${escapeHtml(t("libraryX.modifiedNotice"))}</p>` : ""}${text(license.notice) ? `<details id="voice-license-details"><summary>${escapeHtml(t("libraryX.licenseNotice"))}</summary><pre>${escapeHtml(license.notice)}</pre></details>` : ""}<p class="source-model-terms"><a href="https://github.com/sh-lee-prml/WaveGen#license" target="_blank" rel="noopener noreferrer">${escapeHtml(t("libraryX.modelTerms"))}</a></p>`;
    if ($("voice-license-details")) $("voice-license-details").open = wasOpen;
  }
  async function chooseAvatar(file) {
    const draft = state.modal;
    if (!draft || !file || state.saving) return;
    const revision = ++draft.avatarRevision;
    draft.avatarConverting = true; draft.avatarError = "";
    renderAvatarEditor(); updateSaveButton();
    try {
      const prepared = await prepareAvatar(file);
      if (state.modal !== draft || revision !== draft.avatarRevision) return;
      releaseAvatarPreview(draft);
      draft.avatarSource = file; draft.avatarFile = prepared; draft.avatarRemove = false; draft.avatarDirty = true;
      draft.avatarPreviewUrl = URL.createObjectURL(prepared);
    } catch (error) {
      if (state.modal === draft && revision === draft.avatarRevision) draft.avatarError = readableError(error);
    } finally {
      if (state.modal === draft && revision === draft.avatarRevision) {
        draft.avatarConverting = false; renderAvatarEditor(); updateSaveButton();
      }
    }
  }
  function resetAvatar(remove = false) {
    const draft = state.modal;
    if (!draft || state.saving) return;
    ++draft.avatarRevision; releaseAvatarPreview(draft);
    draft.avatarSource = null; draft.avatarFile = null; draft.avatarError = ""; draft.avatarConverting = false;
    draft.avatarRemove = remove && !!draft.voice?.avatar_url; draft.avatarDirty = draft.avatarRemove;
    $("voice-avatar").value = "";
    renderAvatarEditor(); updateSaveButton();
    $("avatar-choose").focus();
  }
  function openVoiceEditor(voice = null) {
    if (state.stopped || state.saving) return;
    if (state.modal && state.enhancementJob?.draft === state.modal) return;
    if (state.modal) { releasePreview(state.modal); releaseAvatarPreview(state.modal); }
    invalidateReferenceEnhancement(state.modal);
    window.StudioReferenceEditor?.clear();
    state.modal = { voice, original: null, file: null, filename: "", previewUrl: "", audioDirty: false, newSource: false, referenceSettings: null,
      transcriptRequired: false, transcriptConfirmed: false, converting: false, audioError: "", revision: 0, trim: null,
      avatarSource: null, avatarFile: null, avatarPreviewUrl: "", avatarRemove: false, avatarDirty: false, avatarConverting: false, avatarError: "", avatarRevision: 0 };
    $("voice-dialog-title").textContent = voice ? t("voice.settings") : t("library.add");
    $("voice-name").value = voice?.name || "";
    $("reference-text").value = voice?.reference_text || "";
    $("voice-audio").value = "";
    $("voice-avatar").value = "";
    $("trim-silence").checked = voice?.trim_enabled !== false;
    $("reference-edit-open").hidden = !voice?.audio_url;
    $("reference-edit-load-hint").hidden = !voice?.audio_url;
    $("reference-transcript-confirm").hidden = true;
    $("reference-confirmed").checked = false;
    $("reference-preview-heading").textContent = t("referenceX.savedPreview");
    $("audio-upload-title").textContent = voice ? t("voice.replaceAudio") : t("voice.upload");
    $("audio-upload-hint").textContent = t("voice.uploadHint");
    $("audio-dropzone").classList.remove("is-converting", "is-dragover");
    $("audio-preview").hidden = !voice?.audio_url;
    $("audio-file-name").textContent = voice ? t("voice.referenceLabel", { name: voice.name }) : "";
    $("audio-duration").textContent = voice?.duration_seconds ? formatDuration(voice.duration_seconds) : "";
    $("trim-summary").textContent = voice ? (voice.original_audio_url ? t("voice.originalSaved") : t("voice.existingAudio")) : "";
    $("trim-summary").classList.remove("is-error");
    const player = $("reference-player");
    player.pause();
    if (voice?.audio_url) player.src = safeAudioUrl(voice.audio_url); else player.removeAttribute("src");
    player.load();
    $("voice-delete").hidden = !voice;
    $("delete-confirmation").hidden = true;
    $("voice-discard-confirmation").hidden = true;
    $("voice-avatar-options").open = false;
    $("voice-enhancement-options").open = false;
    $("voice-source").open = false;
    $("transcript-reminder").hidden = true;
    $("voice-name").setAttribute("aria-invalid", "false");
    $("reference-text").setAttribute("aria-invalid", "false");
    setError("voice-error");
    renderAvatarEditor(); renderVoiceSource();
    updateSaveButton();
    $("voice-dialog").showModal();
  }
  function voiceEditorDirty() {
    const draft = state.modal;
    if (!draft) return false;
    return $("voice-name").value !== (draft.voice?.name || "") || $("reference-text").value !== (draft.voice?.reference_text || "") || !!draft.filename || draft.pendingSource || draft.audioDirty || !!draft.enhancementPreview || state.enhancementJob?.draft === draft || draft.avatarDirty || draft.avatarConverting || !!draft.avatarError || $("trim-silence").checked !== (draft.voice?.trim_enabled !== false);
  }
  function closeVoiceEditor(force = false) {
    if (state.saving) return;
    if (force !== true && voiceEditorDirty()) {
      $("voice-discard-confirmation").hidden = false;
      $("voice-discard-confirmation").scrollIntoView({ block: "nearest" });
      $("voice-keep-editing").focus();
      return;
    }
    $("reference-player").pause();
    if (state.enhancementJob?.draft === state.modal) cancelReferenceEnhancement();
    invalidateReferenceEnhancement(state.modal);
    window.StudioReferenceEditor?.clear();
    if (state.modal) state.modal.revision++;
    releasePreview(state.modal);
    releaseAvatarPreview(state.modal);
    state.modal = null;
    $("voice-dialog").close();
  }
  function updateSaveButton() {
    const draft = state.modal;
    const enhancing = !!state.enhancementJob;
    $("voice-save").disabled = state.saving || enhancing || !draft || draft.converting || !!draft.audioError || draft.avatarConverting || !!draft.avatarError;
    $("voice-save").textContent = state.saving ? t("voice.saving") : draft?.converting ? t("voice.processing") : draft?.avatarConverting ? t("libraryX.imageProcessing") : draft?.voice ? t("voice.saveChanges") : t("voice.save");
    $("voice-cancel").disabled = state.saving;
    $("voice-dialog-close").disabled = state.saving;
    $("voice-delete").disabled = state.saving || enhancing;
    $("voice-delete-confirm").disabled = state.saving || enhancing;
    $("voice-audio").disabled = state.saving || enhancing;
    $("voice-name").disabled = state.saving;
    $("reference-text").disabled = state.saving;
    $("trim-silence").disabled = state.saving || enhancing || !!draft?.converting || (!!draft?.voice && !draft.original);
    $("reference-edit-open").disabled = state.saving || enhancing || !!draft?.converting;
    $("reference-edit-open").textContent = t(draft?.converting ? "referenceX.loading" : "referenceX.open");
    $("reference-confirmed").disabled = state.saving || !!draft?.converting;
    window.StudioReferenceEditor?.setBusy(state.saving || enhancing || !!draft?.converting);
    for (const id of ["voice-avatar", "avatar-choose", "avatar-remove", "avatar-reset"]) $(id).disabled = state.saving;
    $("voice-audio-recover").hidden = !draft?.audioRecovery;
    $("voice-audio-recover").disabled = state.saving || enhancing || !!draft?.converting;
    const summary = state.saving ? t("voice.saving") : enhancing ? t("uxVoice.saveEnhancing") : draft?.converting ? t("voice.processing") : draft?.avatarConverting ? t("libraryX.imageProcessing") : draft?.avatarError ? t("uxVoice.saveImageIssue") : draft?.audioError ? t(draft.audioRecovery ? "uxVoice.saveAudioIssue" : "uxVoice.saveAudioIssueNew") : draft?.enhancementPreview && !draft.promptEnhancementApplied ? t("uxVoice.chooseEnhancement") : draft?.transcriptRequired && !draft.transcriptConfirmed ? t("uxVoice.saveTranscript") : draft?.promptEnhancementApplied ? t("uxVoice.saveEnhanced") : draft?.audioDirty ? t("uxVoice.savePrepared") : draft?.voice ? t("uxVoice.saveUnchanged") : t("uxVoice.saveNeedsAudio");
    if ($("voice-save-status").textContent !== summary) $("voice-save-status").textContent = summary;
    renderReferenceEnhancement();
  }
  async function decodeToMono(arrayBuffer) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || !window.OfflineAudioContext) throw new Error(t("error.audioSupport"));
    const context = new AudioContextClass();
    let decoded;
    try { decoded = await context.decodeAudioData(arrayBuffer.slice(0)); }
    catch { throw new Error(t("error.audioDecode")); }
    finally { await context.close().catch(() => {}); }
    if (!decoded.length || !Number.isFinite(decoded.duration) || decoded.duration <= 0) throw new Error(t("error.audioEmpty"));
    if (decoded.duration > MAX_SOURCE_SECONDS + .001) throw new Error(t("error.audioSourceLong"));
    const frames = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
  }
  function trimSamples(original, enabled) {
    const windows = Math.ceil(original.length / TRIM_WINDOW);
    const rms = new Float32Array(windows);
    let peak = 0;
    for (let w = 0; w < windows; w++) {
      const end = Math.min(original.length, (w + 1) * TRIM_WINDOW);
      let power = 0;
      for (let i = w * TRIM_WINDOW; i < end; i++) power += original[i] * original[i];
      rms[w] = Math.sqrt(power / (end - w * TRIM_WINDOW));
      peak = Math.max(peak, rms[w]);
    }
    if (!Number.isFinite(peak) || peak < TRIM_FLOOR) throw new Error(t("error.audioSilent"));
    const threshold = Math.max(TRIM_FLOOR, Math.min(TRIM_BASE_THRESHOLD, peak * .04));
    let first = -1, last = -1, activeWindows = 0;
    for (let w = 0; w < windows; w++) {
      if (rms[w] >= threshold) { if (first < 0) first = w; last = w; activeWindows++; }
    }
    if (first < 0 || activeWindows < 3) throw new Error(t("error.audioTooShort"));
    const start = enabled ? Math.max(0, first * TRIM_WINDOW - TRIM_PADDING) : 0;
    const end = enabled ? Math.min(original.length, (last + 1) * TRIM_WINDOW + TRIM_PADDING) : original.length;
    return { samples: original.slice(start, end), startSeconds: start / SAMPLE_RATE, endSeconds: (original.length - end) / SAMPLE_RATE, originalSeconds: original.length / SAMPLE_RATE, threshold };
  }
  function encodePcmWav(samples) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
    ascii(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, "WAVE"); ascii(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ascii(36, "data"); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const sample = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0));
      view.setInt16(44 + i * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
    }
    return new Blob([buffer], { type: "audio/wav" });
  }
  function requireTranscriptCheck(draft) {
    draft.transcriptRequired = true;
    draft.transcriptConfirmed = false;
    $("reference-confirmed").checked = false;
    $("reference-transcript-confirm").hidden = false;
    $("transcript-reminder").hidden = false;
    $("transcript-reminder").textContent = t("referenceX.wordsChanged");
  }
  function setReferenceSource(draft, settings) {
    draft.referenceSettings = { ...settings };
    $("trim-silence").checked = settings.trimEnabled;
    window.StudioReferenceEditor?.setSource({ original: draft.original, settings });
    $("reference-edit-open").hidden = true;
    $("reference-edit-load-hint").hidden = true;
  }
  function sameReferenceSettings(left, right) {
    return !!left && !!right && Math.round(left.startSeconds * SAMPLE_RATE) === Math.round(right.startSeconds * SAMPLE_RATE)
      && Math.round(left.endSeconds * SAMPLE_RATE) === Math.round(right.endSeconds * SAMPLE_RATE)
      && (left.trimEnabled !== false) === (right.trimEnabled !== false) && (left.normalizeEnabled === true) === (right.normalizeEnabled === true);
  }
  function restoreSavedReferenceBaseline(draft) {
    releasePreview(draft);
    draft.file = null; draft.trim = null; draft.audioDirty = false; draft.audioError = "";
    draft.referenceProcessingFailed = false; draft.referenceRangeInvalid = false;
    draft.transcriptRequired = false; draft.transcriptConfirmed = false;
    $("reference-confirmed").checked = false; $("reference-transcript-confirm").hidden = true; $("transcript-reminder").hidden = true;
    $("reference-player").pause(); $("reference-player").src = safeAudioUrl(draft.voice.audio_url); $("reference-player").load();
    $("reference-preview-heading").textContent = t("referenceX.savedPreview");
    $("audio-file-name").textContent = t("voice.referenceLabel", { name: draft.voice.name });
    $("audio-duration").textContent = formatDuration(draft.voice.duration_seconds);
    $("trim-summary").textContent = t("uxVoice.savedBaseline"); $("trim-summary").classList.remove("is-error");
    draft.enhancementStale = false; draft.enhancementNotice = "";
    window.StudioReferenceEditor.setProcessed(null); setError("voice-error");
  }
  function captureAudioRecovery(draft) {
    const fields = ["original", "file", "filename", "newSource", "trim", "audioDirty", "transcriptRequired", "transcriptConfirmed", "promptEnhancementApplied", "enhancementPreview", "enhancementStale", "enhancementNotice"];
    const saved = Object.fromEntries(fields.map(key => [key, draft[key]]));
    saved.referenceSettings = draft.referenceSettings ? { ...draft.referenceSettings } : null;
    saved.referenceBaseline = draft.referenceBaseline ? { ...draft.referenceBaseline } : null;
    saved.confirmedReferenceText = $("reference-text").value;
    return saved;
  }
  function recoverPreviousAudio() {
    const draft = state.modal;
    if (!draft?.audioRecovery || state.saving || draft.converting || state.enhancementJob) return;
    const recovery = draft.audioRecovery;
    ++draft.revision; invalidateReferenceEnhancement(draft); releasePreview(draft);
    Object.assign(draft, recovery);
    if (draft.transcriptRequired && $("reference-text").value !== recovery.confirmedReferenceText) draft.transcriptConfirmed = false;
    draft.audioRecovery = null; draft.audioError = ""; draft.referenceRangeInvalid = false; draft.referenceProcessingFailed = false;
    draft.pendingSource = false; draft.converting = false;
    $("voice-audio").value = "";
    window.StudioReferenceEditor.clear();
    if (draft.original && draft.referenceSettings) {
      setReferenceSource(draft, draft.referenceSettings);
      window.StudioReferenceEditor.setProcessed(draft.trim || null);
    } else {
      $("reference-edit-open").hidden = !draft.voice?.audio_url;
      $("reference-edit-load-hint").hidden = !draft.voice?.audio_url;
      $("trim-silence").checked = draft.voice?.trim_enabled !== false;
    }
    if (draft.file) draft.previewUrl = URL.createObjectURL(draft.file);
    $("audio-preview").hidden = !(draft.file || draft.voice?.audio_url);
    $("reference-player").pause(); $("reference-player").src = draft.promptEnhancementApplied ? draft.enhancementPreview.audioUrl : draft.previewUrl || safeAudioUrl(draft.voice?.audio_url); $("reference-player").load();
    $("reference-transcript-confirm").hidden = !draft.transcriptRequired;
    $("transcript-reminder").hidden = !draft.transcriptRequired;
    $("reference-confirmed").checked = draft.transcriptConfirmed === true;
    if (draft.enhancementPreview) {
      $("reference-before-player").src = draft.enhancementPreview.beforeUrl;
      $("reference-after-player").src = draft.enhancementPreview.audioUrl;
    }
    setError("voice-error"); refreshVoiceLabels(); showToast(t("uxVoice.audioRecovered")); $("reference-player").focus();
  }
  function applyAudioProcessing(draft, wordsMayChange = false) {
    if (!draft.original || draft !== state.modal) return;
    invalidateReferenceEnhancement(draft, true);
    const settings = draft.referenceSettings || { startSeconds: 0, endSeconds: draft.original.length / SAMPLE_RATE, trimEnabled: $("trim-silence").checked, normalizeEnabled: false };
    settings.trimEnabled = $("trim-silence").checked;
    draft.referenceSettings = { ...settings };
    // Undoing every edit must restore the exact saved WAV, including any
    // enhancement. Re-encoding the original would silently replace its sound.
    if (!draft.newSource && draft.voice && sameReferenceSettings(settings, draft.referenceBaseline)) {
      restoreSavedReferenceBaseline(draft); return;
    }
    let trim;
    try { trim = window.StudioReferenceEditor.processAudio(draft.original, settings, trimSamples, SAMPLE_RATE); }
    catch (error) { draft.referenceProcessingFailed = true; throw error; }
    draft.referenceProcessingFailed = false;
    const duration = trim.samples.length / SAMPLE_RATE;
    draft.trim = trim;
    draft.audioDirty = true;
    if (wordsMayChange) requireTranscriptCheck(draft);
    draft.audioError = duration >= MAX_REFERENCE_SECONDS ? t("referenceX.long") : "";
    const blob = encodePcmWav(trim.samples);
    draft.file = new File([blob], (draft.filename.replace(/\.[^.]+$/, "") || "reference") + ".wav", { type: "audio/wav" });
    releasePreview(draft);
    draft.previewUrl = URL.createObjectURL(blob);
    $("audio-preview").hidden = false;
    $("audio-file-name").textContent = draft.filename || t("voice.savedReference");
    $("audio-duration").textContent = formatDuration(duration);
    $("reference-player").pause();
    $("reference-player").src = draft.previewUrl;
    $("reference-player").load();
    $("reference-preview-heading").textContent = t("referenceX.prepared");
    $("audio-upload-title").textContent = t("voice.replaceAudio");
    $("trim-summary").textContent = $("trim-silence").checked
      ? t("voice.trimSummary", { start: trim.startSeconds.toFixed(2), end: trim.endSeconds.toFixed(2), duration: duration.toFixed(2) })
      : t("voice.trimOffSummary", { duration: duration.toFixed(2) });
    $("trim-summary").classList.toggle("is-error", !!draft.audioError);
    setError("voice-error", draft.audioError);
    window.StudioReferenceEditor.setProcessed(trim);
  }
  async function chooseAudio(file) {
    const draft = state.modal;
    if (!draft || !file || state.saving || state.enhancementJob) return;
    if (!draft.audioRecovery && !draft.audioError && (draft.file || draft.voice?.audio_url)) draft.audioRecovery = captureAudioRecovery(draft);
    invalidateReferenceEnhancement(draft, true);
    const revision = ++draft.revision;
    setError("voice-error");
    draft.audioError = "";
    draft.pendingSource = true;
    draft.converting = true;
    $("audio-dropzone").classList.add("is-converting");
    $("audio-upload-title").textContent = t("voice.reading");
    updateSaveButton();
    try {
      if (!/\.(wav|mp3)$/i.test(file.name)) throw new Error(t("error.audioFormat"));
      if (file.size > MAX_FILE_BYTES) throw new Error(t("error.audioFileLarge"));
      if (!file.size) throw new Error(t("error.audioFileEmpty"));
      const original = await decodeToMono(await file.arrayBuffer());
      if (draft !== state.modal || revision !== draft.revision) return;
      draft.original = original;
      draft.filename = file.name;
      draft.newSource = true;
      setReferenceSource(draft, { startSeconds: 0, endSeconds: original.length / SAMPLE_RATE, trimEnabled: $("trim-silence").checked, normalizeEnabled: false });
      requireTranscriptCheck(draft);
      applyAudioProcessing(draft, true);
      if (!draft.audioError) draft.audioRecovery = null;
    } catch (error) {
      if (draft !== state.modal || revision !== draft.revision) return;
      draft.audioError = readableError(error);
      setError("voice-error", draft.audioError);
      $("audio-upload-title").textContent = t("voice.chooseOtherFile");
    } finally {
      if (draft === state.modal && revision === draft.revision) {
        draft.pendingSource = false;
        draft.converting = false;
        $("audio-dropzone").classList.remove("is-converting");
        updateSaveButton();
      }
    }
  }
  async function loadReferenceEditor() {
    const draft = state.modal;
    if (!draft || draft.converting || state.saving || state.enhancementJob || !draft.voice?.audio_url) return;
    if (draft.original) return;
    const revision = ++draft.revision;
    const recovery = captureAudioRecovery(draft);
    draft.converting = true;
    updateSaveButton();
    try {
      const response = await authenticatedFetch(safeAudioUrl(draft.voice.original_audio_url || draft.voice.audio_url));
      if (!response.ok) throw new Error(t("error.audioReadSaved"));
      const original = await decodeToMono(await response.arrayBuffer());
      if (draft !== state.modal || revision !== draft.revision) return;
      draft.original = original;
      draft.audioError = "";
      const voice = draft.voice;
      const hasEdit = voice.reference_edit_version === 1;
      const settings = { startSeconds: hasEdit ? Number(voice.selection_start_seconds) : 0,
        endSeconds: hasEdit ? Number(voice.selection_end_seconds) : original.length / SAMPLE_RATE,
        trimEnabled: voice.trim_enabled !== false, normalizeEnabled: hasEdit && voice.normalize_enabled === true };
      draft.referenceBaseline = { ...settings };
      setReferenceSource(draft, settings);
      draft.audioRecovery = null;
      // Loading gives access to the immutable source only. Keep the stored WAV,
      // save payload and dirty flag untouched until the user changes a setting.
      $("trim-summary").textContent = t("referenceX.loaded");
      setError("voice-error");
    } catch (error) {
      if (draft === state.modal && revision === draft.revision) {
        draft.audioRecovery = recovery;
        draft.audioError = readableError(error);
        setError("voice-error", draft.audioError);
      }
    } finally {
      if (draft === state.modal && revision === draft.revision) { draft.converting = false; updateSaveButton(); }
    }
  }
  function toggleTrim() {
    const draft = state.modal;
    if (!draft || draft.converting || state.saving || state.enhancementJob || !draft.original) return;
    window.StudioReferenceEditor.changeSettings({ trimEnabled: $("trim-silence").checked });
  }
  async function saveVoice(event) {
    event.preventDefault();
    const draft = state.modal;
    if (!draft || state.saving || state.enhancementJob || draft.converting || draft.audioError || draft.avatarConverting || draft.avatarError) return;
    setError("voice-error");
    if (draft.enhancementPreview && !draft.promptEnhancementApplied) {
      $("voice-enhancement-options").open = true;
      setError("reference-enhancement-error", t("uxVoice.chooseEnhancement"));
      $("reference-enhance-apply").focus();
      return;
    }
    const name = $("voice-name").value.trim();
    const reference = $("reference-text").value.trim();
    if (!name) { setError("voice-error", t("error.voiceName")); $("voice-name").focus(); return; }
    if (new TextEncoder().encode(name).length > 160) { setError("voice-error", t("error.voiceNameLong")); $("voice-name").setAttribute("aria-invalid", "true"); $("voice-name").focus(); return; }
    if (!reference) { setError("voice-error", t("error.referenceText")); $("reference-text").focus(); return; }
    const referenceIssue = textIssue(reference, 4000, t("validation.referenceLabel"));
    if (referenceIssue) { setError("voice-error", referenceIssue); $("reference-text").setAttribute("aria-invalid", "true"); $("reference-text").focus(); return; }
    if (!draft.voice && !draft.file && !draft.promptEnhancementApplied) { setError("voice-error", t("error.referenceFile")); return; }
    if (draft.transcriptRequired && !draft.transcriptConfirmed) {
      setError("voice-error", t("referenceX.confirmNeeded"));
      $("reference-confirmed").focus();
      return;
    }
    const form = new FormData();
    form.append("name", name);
    form.append("reference_text", reference);
    if (draft.avatarDirty) {
      if (draft.avatarFile) form.append("avatar", draft.avatarFile, "character.png");
      else if (draft.avatarRemove) form.append("remove_avatar", "true");
    }
    const enhanced = draft.promptEnhancementApplied ? draft.enhancementPreview : null;
    const audioFile = enhanced?.file || draft.file, prepared = enhanced?.trim || draft.trim;
    if (draft.audioDirty && audioFile) {
      form.append("audio", audioFile, audioFile.name);
      if (enhanced) form.append("prompt_enhancement_id", enhanced.id);
      // Keep the untrimmed mono source so a later edit or app restart can undo trimming.
      if (draft.original && draft.newSource) form.append("original_audio", encodePcmWav(draft.original), "reference-original.wav");
      form.append("trim_enabled", String($("trim-silence").checked));
      form.append("trim_start_seconds", String(prepared?.startSeconds || 0));
      form.append("trim_end_seconds", String(prepared?.endSeconds || 0));
      form.append("original_duration_seconds", String(prepared?.originalSeconds || 0));
      form.append("reference_edit_version", "1");
      form.append("selection_start_seconds", String(prepared.selectionStartSeconds));
      form.append("selection_end_seconds", String(prepared.selectionEndSeconds));
      form.append("normalize_enabled", String(draft.referenceSettings.normalizeEnabled));
      form.append("normalization_gain_db", String(prepared.normalizationGainDb));
    }
    state.saving = true;
    updateSaveButton();
    try {
      const payload = await api(draft.voice ? `/api/voices/${encodeURIComponent(draft.voice.id)}` : "/api/voices", { method: draft.voice ? "PUT" : "POST", body: form });
      const saved = payload.voice || payload;
      state.selectedId = String(saved.id);
      state.requireVoiceSelection = false;
      state.showingTrash = false;
      persistDraft();
      if (payload.warning || saved.warning) updateWarnings("save", payload.warning || saved.warning);
      await refreshVoices();
      state.saving = false;
      closeVoiceEditor(true);
      showToast(draft.voice ? t("voice.updated") : t("voice.saved"));
    } catch (error) { setError("voice-error", readableError(error)); }
    finally { state.saving = false; updateSaveButton(); }
  }
  async function deleteVoice() {
    const draft = state.modal;
    if (!draft?.voice || state.saving) return;
    state.saving = true;
    updateSaveButton();
    setError("voice-error");
    try {
      await api(`/api/voices/${encodeURIComponent(draft.voice.id)}`, { method: "DELETE" });
      await Promise.allSettled([refreshVoices(), refreshTrash()]);
      state.saving = false;
      closeVoiceEditor(true);
      showToast(t("library.trashed"), false, { label: t("common.undo"), run: () => restoreVoice(draft.voice.id) });
    } catch (error) { setError("voice-error", readableError(error)); }
    finally { state.saving = false; updateSaveButton(); }
  }
  function openShutdown() {
    if (state.stopped) return;
    const busy = isBusy();
    $("shutdown-description").textContent = t(busy ? "shutdown.busy" : "shutdown.description");
    $("shutdown-confirm").disabled = busy;
    setError("shutdown-error");
    $("shutdown-dialog").showModal();
  }
  async function shutdown() {
    if (state.shuttingDown || state.stopped || isBusy()) return;
    state.shuttingDown = true;
    $("shutdown-confirm").disabled = true;
    $("shutdown-confirm").textContent = t("shutdown.closing");
    try {
      await api("/api/shutdown", { method: "POST" });
      state.stopped = true;
      $("shutdown-dialog").close();
      document.body.classList.add("shutdown-screen");
      document.querySelector(".app-footer>span").textContent = t("shutdown.closed");
      $("shutdown-open").disabled = true;
      renderStatus();
      showToast(t("shutdown.toast"));
    } catch (error) {
      setError("shutdown-error", readableError(error));
      $("shutdown-confirm").disabled = false;
      $("shutdown-confirm").textContent = t("shutdown.action");
    } finally { state.shuttingDown = false; }
  }
  function renderDraftLabels() {
    renderModelControl("generation-model", "generation-model-hint", state.modelId, isBusy() || state.stopped);
    const bytes = new TextEncoder().encode($("generation-text").value.trim()).length;
    $("text-count").innerHTML = `${bytes.toLocaleString(i18n.getLocale())} <span>/ 5,000</span>`;
    $("text-count").title = t("composer.byteHint");
    $("speed-value").value = `${Number($("speed").value).toFixed(2)}×`;
    const target = $("duration-mode").value === "target";
    $("speed").disabled = target;
    $("speed-field").classList.toggle("is-disabled", target);
    $("speed-duration-hint").hidden = !target;
    $("duration-target-field").hidden = !target;
    $("seed").disabled = $("seed-every-time").checked;
    $("seed-random").disabled = $("seed-every-time").checked;
    setText("seed-hint", t($("seed-every-time").checked ? "features.seedEveryHint" : "composer.seedHint"));
    $("generation-hint").textContent = $("split-long-text").checked ? t("composer.splitLimit") : t("composer.singleLimit");
    const chips = [];
    if (target && !durationIssue()) chips.push(t("features.durationChip", { seconds: Number($("duration-seconds").value).toFixed(2) }));
    if (!target && Number($("speed").value) !== 1) chips.push(t("composer.speedChip", { speed: Number($("speed").value).toFixed(2) }));
    if ($("seed-every-time").checked) chips.push(t("features.seedEveryChip"));
    else if (Number($("seed").value) !== 0) chips.push(t("composer.seedChip", { seed: $("seed").value }));
    if (!$("split-long-text").checked) chips.push(t("composer.splitOff"));
    if ($("enhance-output").checked) chips.push(t("enhance.outputOption"));
    $("draft-settings").hidden = !chips.length;
    $("draft-settings").textContent = chips.join(" · ");
    setText("settings-summary", [$("split-long-text").checked ? t("output.splitOn") : t("composer.splitOff"), $("enhance-output").checked ? t("output.enhanceOn") : ""].filter(Boolean).join(" · "));
  }
  function onDraftChanged() {
    renderDraftLabels();
    persistDraft();
    setError("generation-error");
    schedulePlan();
  }

  function refreshPlanLabels() {
    const plan = state.plan;
    if (plan.state === "ready") {
      const count = Number(plan.value.segment_count || plan.value.segments?.length || 1);
      setText("plan-status", t(count > 1 ? "plan.summaryMany" : "plan.summaryOne", { duration: formatDuration(plan.value.duration_seconds), count }));
      $("plan-segments").innerHTML = (plan.value.segments || []).map((segment, index) => `<li><span class="segment-label">${index + 1} · ${escapeHtml(formatDuration(segment.duration_seconds))}</span><p>${escapeHtml(segment.text)}</p></li>`).join("");
    } else if (plan.state === "error") setText("plan-status", readableError(plan.error));
    else setText("plan-status", t(plan.state === "pending" ? "plan.loading" : plan.state === "invalid" ? "plan.invalid" : !selectedVoice() ? "plan.chooseVoice" : "plan.empty"));
  }
  function refreshVoiceLabels() {
    const draft = state.modal;
    if (!draft) return;
    renderAvatarEditor(); renderVoiceSource();
    setText("voice-dialog-title", t(draft.voice ? "voice.settings" : "library.add"));
    setText("audio-upload-title", t(draft.converting ? "voice.reading" : draft.audioError && !draft.file ? "voice.chooseOtherFile" : draft.voice || draft.file ? "voice.replaceAudio" : "voice.upload"));
    setText("audio-upload-hint", t("voice.uploadHint"));
    setText("audio-file-name", draft.filename || (draft.voice ? t("voice.referenceLabel", { name: draft.voice.name }) : ""));
    setText("reference-preview-heading", t(draft.promptEnhancementApplied ? "enhance.after" : draft.audioDirty ? "referenceX.prepared" : "referenceX.savedPreview"));
    if (draft.transcriptRequired) setText("transcript-reminder", t("referenceX.wordsChanged"));
    if (draft.trim) {
      const duration = draft.trim.samples.length / SAMPLE_RATE;
      setText("audio-duration", formatDuration(duration));
      setText("trim-summary", t($("trim-silence").checked ? "voice.trimSummary" : "voice.trimOffSummary", { start: draft.trim.startSeconds.toFixed(2), end: draft.trim.endSeconds.toFixed(2), duration: duration.toFixed(2) }));
    } else {
      setText("audio-duration", draft.voice?.duration_seconds ? formatDuration(draft.voice.duration_seconds) : "");
      setText("trim-summary", draft.original ? t("referenceX.loaded") : draft.voice ? t(draft.voice.original_audio_url ? "voice.originalSaved" : "voice.existingAudio") : "");
    }
    updateSaveButton();
  }
  function refreshLocale() {
    i18n.applyStatic();
    document.documentElement.lang = i18n.getLocale() === "zh" ? "zh-CN" : i18n.getLocale();
    $("ui-language").value = i18n.getLocale();
    renderDraftLabels();
    renderVoices();
    renderSelection();
    refreshPlanLabels();
    if (state.generating || state.recovering) { renderWorkingResult(); renderHistory(); }
    else renderResults();
    renderStatus();
    refreshVoiceLabels();
    for (const [id, message] of Object.entries(state.errorMessages)) setError(id, message);
    // Rebuild composite validation examples from the unchanged input, not translated fragments.
    if (state.plan.state === "invalid") setError("generation-error", modelIssue() || enhancementIssue() || textIssue($("generation-text").value.trim(), 5000, t("validation.generationLabel")) || durationIssue());
    if (state.modal && $("reference-text").getAttribute("aria-invalid") === "true") {
      const issue = textIssue($("reference-text").value.trim(), 4000, t("validation.referenceLabel"));
      if (issue) setError("voice-error", issue);
    }
    updateWarnings("locale", []);
    if (state.toast) {
      setText("toast-message", (Array.isArray(state.toast.message) ? state.toast.message : [state.toast.message]).map((message) => i18n.translate(message)).join(" "));
      if (state.toast.action) setText("toast-action", i18n.translate(state.toast.action.label));
    }
    setText("shutdown-description", t(isBusy() ? "shutdown.busy" : "shutdown.description"));
    setText("shutdown-confirm", t(state.shuttingDown ? "shutdown.closing" : "shutdown.action"));
    if (state.stopped) document.querySelector(".app-footer>span").textContent = t("shutdown.closed");
    window.StudioSpeechEdit?.refreshLocale();
    window.StudioReferenceEditor?.refreshLocale();
  }

  async function receiveEditedResult(item) {
    state.activeResultId = String(item.id);
    state.history = [item, ...state.history.filter((previous) => String(previous.id) !== String(item.id))];
    if (item.history_saved === false) state.unsavedResults.set(String(item.id), item);
    if (item.warning) updateWarnings("save", item.warning);
    renderResults();
    await refreshHistory(item.id);
    await refreshStatus();
  }

  $("ui-language").addEventListener("change", (event) => i18n.setLocale(event.target.value));
  window.addEventListener("studio-locale-change", refreshLocale);
  $("voice-add").addEventListener("click", () => openVoiceEditor());
  $("voice-add-icon").addEventListener("click", () => openVoiceEditor());
  $("selected-voice-edit").addEventListener("click", () => { if (selectedVoice()) openVoiceEditor(selectedVoice()); });
  $("voice-search").addEventListener("input", renderVoices);
  $("voice-list").addEventListener("click", (event) => {
    const restore = event.target.closest("[data-restore-id]");
    if (restore) { restoreVoice(restore.dataset.restoreId); return; }
    if (event.target.closest("[data-trash-retry]")) { refreshTrash(); return; }
    const button = event.target.closest("[data-voice-id]");
    if (!button) return;
    state.selectedId = button.dataset.voiceId;
    state.requireVoiceSelection = false;
    onDraftChanged();
    renderVoices();
  });
  $("library-active").addEventListener("click", () => { state.showingTrash = false; renderVoices(); });
  $("library-trash").addEventListener("click", () => { state.showingTrash = true; renderVoices(); refreshTrash(); });
  $("generation-text").value = initialDraft.text;
  $("generation-model").value = initialDraft.model_id;
  $("generation-model").addEventListener("change", (event) => {
    if (isBusy() || state.stopped) { renderModelControl("generation-model", "generation-model-hint", state.modelId, true); return; }
    state.modelId = event.target.value; onDraftChanged();
  });
  $("speed").value = initialDraft.speed;
  $("seed").value = initialDraft.seed;
  $("seed-every-time").checked = initialDraft.randomize_seed;
  $("duration-mode").value = initialDraft.duration_mode;
  $("duration-seconds").value = initialDraft.duration_seconds;
  $("split-long-text").checked = initialDraft.split_long_text;
  $("enhance-output").checked = initialDraft.enhance_output;
  $("generation-text").addEventListener("input", onDraftChanged);
  $("generation-text").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !$("generate-button").disabled) { event.preventDefault(); generate(); }
  });
  $("speed").addEventListener("input", onDraftChanged);
  $("seed").addEventListener("input", onSeedChanged);
  $("seed-random").addEventListener("click", randomizeSeed);
  $("seed-every-time").addEventListener("change", onSeedChanged);
  $("duration-mode").addEventListener("change", onDraftChanged);
  $("duration-seconds").addEventListener("input", onDraftChanged);
  $("split-long-text").addEventListener("change", onDraftChanged);
  $("enhance-output").addEventListener("change", () => { if (isBusy()) { $("enhance-output").checked = (state.request?.draft?.enhance_output ?? readDraft().enhance_output) === true; return; } onDraftChanged(); });
  $("plan-retry").addEventListener("click", () => schedulePlan(0));
  $("generate-button").addEventListener("click", generate);
  $("show-output").addEventListener("click", () => {
    $("current-output").focus({ preventScroll: true });
    $("current-output").scrollIntoView({ block: "start", behavior: "auto" });
  });
  $("cancel-generation").addEventListener("click", cancelGeneration);
  $("connection-retry").addEventListener("click", () => { refreshStatus(); scheduleStatusPoll(0); });
  $("history-search").addEventListener("input", searchHistory);
  $("history-more").addEventListener("click", loadMoreHistory);
  $("history-retry").addEventListener("click", () => refreshHistory());
  $("history-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-result-id]");
    if (!button || state.generating || state.recovering) return;
    state.activeResultId = button.dataset.resultId;
    renderResults();
    $("generated-player")?.play().catch(() => {});
  });
  document.addEventListener("play", (event) => {
    if (!(event.target instanceof HTMLMediaElement)) return;
    document.querySelectorAll("audio").forEach((audio) => { if (audio !== event.target) audio.pause(); });
  }, true);
  document.addEventListener("error", (event) => { if (event.target?.matches?.("img[data-voice-avatar]")) event.target.remove(); }, true);
  $("voice-dialog-close").addEventListener("click", closeVoiceEditor);
  $("voice-cancel").addEventListener("click", closeVoiceEditor);
  $("voice-keep-editing").addEventListener("click", () => { $("voice-discard-confirmation").hidden = true; $("voice-save").focus(); });
  $("voice-discard").addEventListener("click", () => closeVoiceEditor(true));
  $("voice-dialog").addEventListener("cancel", (event) => { event.preventDefault(); closeVoiceEditor(); });
  $("voice-dialog").addEventListener("click", (event) => { if (event.target === $("voice-dialog")) { const r = $("voice-dialog").getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeVoiceEditor(); } });
  $("voice-form").addEventListener("submit", saveVoice);
  $("voice-name").addEventListener("input", () => { $("voice-name").setAttribute("aria-invalid", "false"); renderAvatarEditor(); });
  $("reference-text").addEventListener("input", () => {
    $("reference-text").setAttribute("aria-invalid", "false");
    if (state.modal?.transcriptRequired) { state.modal.transcriptConfirmed = false; $("reference-confirmed").checked = false; }
    updateSaveButton();
  });
  $("reference-edit-open").addEventListener("click", loadReferenceEditor);
  $("reference-enhance").addEventListener("click", enhanceReference);
  $("reference-enhance-cancel").addEventListener("click", cancelReferenceEnhancement);
  $("reference-enhance-apply").addEventListener("click", applyReferenceEnhancement);
  $("reference-enhance-discard").addEventListener("click", discardReferenceEnhancement);
  $("reference-confirmed").addEventListener("change", () => {
    if (!state.modal || state.saving) return;
    state.modal.transcriptConfirmed = $("reference-confirmed").checked;
    if (state.modal.transcriptConfirmed && !state.modal.audioError) setError("voice-error");
    updateSaveButton();
  });
  $("reference-player").addEventListener("play", () => window.StudioReferenceEditor?.stop());
  $("voice-audio").addEventListener("change", () => { const file = $("voice-audio").files?.[0]; $("voice-audio").value = ""; chooseAudio(file); });
  $("voice-audio-recover").addEventListener("click", recoverPreviousAudio);
  window.addEventListener("beforeunload", (event) => {
    if (!voiceEditorDirty()) return;
    event.preventDefault(); event.returnValue = "";
  });
  $("avatar-choose").addEventListener("click", () => $("voice-avatar").click());
  $("voice-avatar").addEventListener("change", () => { chooseAvatar($("voice-avatar").files?.[0]); $("voice-avatar").value = ""; });
  $("avatar-remove").addEventListener("click", () => resetAvatar(true));
  $("avatar-reset").addEventListener("click", () => resetAvatar(false));
  $("avatar-dropzone").addEventListener("dragover", (event) => { event.preventDefault(); if (!state.saving) $("avatar-dropzone").classList.add("is-dragover"); });
  $("avatar-dropzone").addEventListener("dragleave", () => $("avatar-dropzone").classList.remove("is-dragover"));
  $("avatar-dropzone").addEventListener("drop", (event) => { event.preventDefault(); $("avatar-dropzone").classList.remove("is-dragover"); chooseAvatar(event.dataTransfer?.files?.[0]); });
  $("trim-silence").addEventListener("change", toggleTrim);
  $("audio-dropzone").addEventListener("dragover", (event) => { event.preventDefault(); if (!state.saving) $("audio-dropzone").classList.add("is-dragover"); });
  $("audio-dropzone").addEventListener("dragleave", () => $("audio-dropzone").classList.remove("is-dragover"));
  $("audio-dropzone").addEventListener("drop", (event) => { event.preventDefault(); $("audio-dropzone").classList.remove("is-dragover"); chooseAudio(event.dataTransfer?.files?.[0]); });
  $("voice-delete").addEventListener("click", () => { $("delete-confirmation").hidden = false; $("voice-delete-confirm").focus(); });
  $("voice-delete-cancel").addEventListener("click", () => { $("delete-confirmation").hidden = true; });
  $("voice-delete-confirm").addEventListener("click", deleteVoice);
  $("shutdown-open").addEventListener("click", openShutdown);
  $("shutdown-footer").addEventListener("click", openShutdown);
  $("shutdown-cancel").addEventListener("click", () => { if (!state.shuttingDown) $("shutdown-dialog").close(); });
  $("shutdown-confirm").addEventListener("click", shutdown);
  $("shutdown-dialog").addEventListener("cancel", (event) => { if (state.shuttingDown) event.preventDefault(); });
  window.StudioSpeechEdit?.init({ api, t, escapeHtml, safeAudioUrl, formatDuration, readableError, showToast, refreshHistory, modelId, modelIssue, renderModelControl,
    getVoices: () => state.voices,
    getStatus: () => ({ ...state.status, state: state.stopped ? "stopped" : state.status.state === "loading_model" ? "loading_model" : state.generating || state.speechEditing || state.enhancementJob || state.recovering || ["loading_enhancement", "enhancing"].includes(state.status.state) ? "generating" : state.status.state }),
    onResult: receiveEditedResult,
    onBusyChange: (busy) => { state.speechEditing = !!busy; updateGenerateButton(); scheduleStatusPoll(0); },
  });
  window.StudioReferenceEditor?.init({ t, encodePcmWav,
    onPreviewStart: () => $("reference-player").pause(),
    onInvalid: (message) => {
      if (!state.modal) return;
      state.modal.referenceRangeInvalid = true; state.modal.audioError = message;
      setError("voice-error", message); updateSaveButton();
    },
    onValid: () => {
      const draft = state.modal;
      if (!draft?.referenceRangeInvalid) return;
      draft.referenceRangeInvalid = false;
      if (draft.referenceProcessingFailed) {
        // A valid numeric range may still contain only silence. Reprocess the
        // current settings before allowing a previously prepared file to save.
        try { applyAudioProcessing(draft); }
        catch (error) { draft.audioError = readableError(error); }
      } else draft.audioError = draft.trim?.samples.length / SAMPLE_RATE >= MAX_REFERENCE_SECONDS ? t("referenceX.long") : "";
      setError("voice-error", draft.audioError); updateSaveButton();
    },
    onChange: (settings, { wordsMayChange }) => {
      const draft = state.modal;
      if (!draft || state.saving || state.enhancementJob || draft.converting) return;
      draft.referenceRangeInvalid = false;
      draft.referenceSettings = { ...settings };
      $("trim-silence").checked = settings.trimEnabled;
      try { applyAudioProcessing(draft, wordsMayChange); }
      catch (error) { draft.audioError = readableError(error); setError("voice-error", draft.audioError); }
      updateSaveButton();
    }
  });
  refreshLocale();
  onDraftChanged();
  if (state.recovering) renderWorkingResult();
  Promise.allSettled([refreshStatus(), refreshVoices(), refreshHistory(), refreshTrash()]).then(() => scheduleStatusPoll());
})();
