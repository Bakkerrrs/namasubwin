// Orquestación de la app (equivalente al TranslatorViewModel de iOS):
// fuente → captura → [reproducción diferida] + [audio → Realtime API] →
// línea de tiempo de subtítulos → capa quemada sobre el video.

import {
  listCameras,
  listAudioInputs,
  listAudioOutputs,
  warmUpPermissions,
  buildStream,
  cropStream,
} from "./capture.js";
import { DelayedPlayer } from "./delaybuffer.js";
import { RealtimeService, REALTIME_MODELS, fallbackTranslate } from "./realtime.js";
import { TranslationQueue, TRANSLATE_MODELS } from "./translator.js";
import { LocalVad } from "./localvad.js";
import { SubtitleTimeline } from "./subtitles.js";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Registro de depuración (activable en el panel: "Modo debug")
// ---------------------------------------------------------------------------

const dbg = {
  lines: [],
  max: 600,
  lastRms: 0,
  log(tag, msg) {
    const time = new Date().toISOString().slice(11, 23);
    const line = `${time} [${tag}] ${msg}`;
    this.lines.push(line);
    if (this.lines.length > this.max) this.lines.shift();
    console.debug(line);
    const el = $("debug-log");
    if (el && !el.parentElement.classList.contains("hidden")) {
      el.textContent = this.lines.slice(-200).join("\n");
      el.scrollTop = el.scrollHeight;
    }
  },
  text() {
    return this.lines.join("\n");
  },
};

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

const state = {
  running: false,
  selectedSource: null, // {kind:"screen"|"window", id} de la grilla
  stream: null,
  player: null,         // DelayedPlayer
  realtime: null,       // RealtimeService (traducción o transcripción según motor)
  translator: null,     // TranslationQueue (solo motor livetranscribe)
  localVad: null,       // LocalVad (solo motor livetranscribe: fecha los turnos)
  timeline: null,       // SubtitleTimeline
  audioCtx: null,
  workletNode: null,
  recordingPath: null,
  fallbackTimer: 0,
  renderTimer: 0,
  debugTimer: 0,
  apiKeyFromEnv: false,
  // El reloj de VAD del servidor (audio_start_ms) parte de 0 en CADA sesión
  // WebSocket; tras una reconexión hay que sumarle el tiempo de captura ya
  // transcurrido para seguir fechando bien los subtítulos.
  sessionBaseMs: 0,
  lastSpeechStartMs: 0, // inicio del turno local en curso (para el commit)
  deltaCount: 0,        // deltas de transcripción recibidos (visibilidad debug)
  // Emparejamiento exacto commit→item→transcripción (motor Live-Transcribe):
  pendingCommits: [],       // ventanas [start,end] de commits sin item_id aún
  itemWindows: new Map(),   // item_id → ventana del turno local que lo produjo
};

// ---------------------------------------------------------------------------
// Configuración persistente (localStorage, como UserDefaults en iOS)
// ---------------------------------------------------------------------------

const prefs = {
  load() {
    try {
      return JSON.parse(localStorage.getItem("namasub-prefs")) || {};
    } catch {
      return {};
    }
  },
  save(partial) {
    localStorage.setItem(
      "namasub-prefs",
      JSON.stringify({ ...prefs.load(), ...partial })
    );
  },
};

// ---------------------------------------------------------------------------
// Inicialización de la UI
// ---------------------------------------------------------------------------

async function init() {
  // Modelos Realtime (motor clásico) y de traducción (motor Live-Transcribe)
  for (const model of REALTIME_MODELS) {
    const opt = document.createElement("option");
    opt.value = model;
    opt.textContent = model;
    $("model-select").appendChild(opt);
  }
  for (const model of TRANSLATE_MODELS) {
    const opt = document.createElement("option");
    opt.value = model;
    opt.textContent = model;
    $("translate-model-select").appendChild(opt);
  }

  // Preferencias guardadas
  const saved = prefs.load();
  if (saved.model && REALTIME_MODELS.includes(saved.model)) {
    $("model-select").value = saved.model;
  }
  if (saved.engine) $("engine-select").value = saved.engine;
  if (saved.translateModel && TRANSLATE_MODELS.includes(saved.translateModel)) {
    $("translate-model-select").value = saved.translateModel;
  }
  if (saved.ltDelay) $("lt-delay").value = saved.ltDelay;
  if (saved.ltPrompt) $("lt-prompt").value = saved.ltPrompt;
  if (saved.ltKeywords) $("lt-keywords").value = saved.ltKeywords;
  applyEngineVisibility();
  if (saved.delay) $("delay").value = saved.delay;
  if (saved.vadThreshold) $("vad-threshold").value = saved.vadThreshold;
  if (saved.vadPrefix) $("vad-prefix").value = saved.vadPrefix;
  if (saved.vadSilence) $("vad-silence").value = saved.vadSilence;
  if (saved.bilingual) $("bilingual").checked = true;
  if (saved.debug) {
    $("debug-mode").checked = true;
    $("debug-panel").classList.remove("hidden");
  }
  if (saved.hdrFix) $("hdr-fix").checked = true;
  if (saved.hdrLevel) $("hdr-level").value = saved.hdrLevel;
  $("hdr-level-label").textContent = $("hdr-level").value;
  applyHdrFilter();
  if (saved.crop) {
    $("crop-top").value = saved.crop.top ?? 0;
    $("crop-bottom").value = saved.crop.bottom ?? 0;
    $("crop-left").value = saved.crop.left ?? 0;
    $("crop-right").value = saved.crop.right ?? 0;
  }
  if (saved.subFont) $("sub-font").value = saved.subFont;
  if (saved.subSize) $("sub-size").value = saved.subSize;
  if (saved.subBg != null) $("sub-bg").value = saved.subBg;
  applySubtitleStyle();
  syncSliderLabels();

  // API key guardada (env > cifrada en disco)
  const { key, fromEnv } = await window.namasub.getApiKey();
  $("api-key").value = key;
  state.apiKeyFromEnv = fromEnv;
  if (fromEnv) $("api-key").disabled = true;

  await warmUpPermissions();
  await refreshSources();
  wireEvents();
}

function syncSliderLabels() {
  $("delay-label").textContent = `${$("delay").value} s`;
  $("vad-threshold-label").textContent = $("vad-threshold").value;
  $("vad-prefix-label").textContent = $("vad-prefix").value;
  $("vad-silence-label").textContent = $("vad-silence").value;
}

async function refreshSources() {
  // Pantallas y ventanas (con miniaturas, estilo OBS)
  const sources = await window.namasub.listSources();
  const grid = $("source-grid");
  grid.innerHTML = "";
  for (const src of sources) {
    const item = document.createElement("div");
    item.className = "source-item";
    item.dataset.id = src.id;
    item.innerHTML = `<img alt=""><div class="name"></div>`;
    item.querySelector("img").src = src.thumbnail;
    item.querySelector(".name").textContent =
      (src.kind === "screen" ? "🖥 " : "🪟 ") + src.name;
    item.addEventListener("click", () => {
      grid.querySelectorAll(".source-item").forEach((el) =>
        el.classList.remove("selected")
      );
      item.classList.add("selected");
      state.selectedSource = { kind: src.kind, id: src.id };
      $("camera-select").value = "";
    });
    grid.appendChild(item);
  }
  // Selecciona la primera pantalla por defecto
  const first = grid.querySelector(".source-item");
  if (first && !state.selectedSource) first.click();

  // Cámaras / capturadoras
  const cams = await listCameras();
  const camSel = $("camera-select");
  camSel.length = 1;
  for (const cam of cams) {
    const opt = document.createElement("option");
    opt.value = cam.deviceId;
    opt.textContent = "🎥 " + cam.label;
    camSel.appendChild(opt);
  }

  // Entradas de audio
  const mics = await listAudioInputs();
  const audioSel = $("audio-select");
  audioSel.length = 1;
  for (const mic of mics) {
    const opt = document.createElement("option");
    opt.value = mic.deviceId;
    opt.textContent = "🎙 " + mic.label;
    audioSel.appendChild(opt);
  }

  // Salidas de audio para el reproductor diferido (setSinkId). Elegir una
  // distinta a la capturada corta el bucle de eco del loopback.
  const outs = await listAudioOutputs();
  const outSel = $("output-select");
  const savedOut = prefs.load().outputDevice;
  outSel.length = 1;
  for (const out of outs) {
    if (out.deviceId === "default") continue;
    const opt = document.createElement("option");
    opt.value = out.deviceId;
    opt.textContent = "🔊 " + out.label;
    outSel.appendChild(opt);
  }
  if (savedOut && [...outSel.options].some((o) => o.value === savedOut)) {
    outSel.value = savedOut;
  }
  await applyOutputDevice();
}

/** Aplica fuente, tamaño y transparencia del fondo a la capa de subtítulos. */
function applySubtitleStyle() {
  const layer = $("subtitle-layer");
  const font = $("sub-font").value.trim() || "Segoe UI";
  const scale = parseInt($("sub-size").value, 10) / 100;
  const alpha = parseInt($("sub-bg").value, 10) / 100;
  // Nombre de fuente entre comillas por si contiene espacios (Yu Gothic UI).
  layer.style.setProperty("--sub-font", `"${font.replace(/"/g, "")}"`);
  layer.style.setProperty("--sub-scale", String(scale));
  layer.style.setProperty("--sub-bg-alpha", String(alpha));
  $("sub-size-label").textContent = `${$("sub-size").value}%`;
  $("sub-bg-label").textContent = `${$("sub-bg").value}%`;
}

/** Re-satura y contrasta la imagen para compensar la captura HDR lavada. */
function applyHdrFilter() {
  const player = $("player");
  if (!$("hdr-fix").checked) {
    player.style.filter = "";
    return;
  }
  const level = parseInt($("hdr-level").value, 10) / 100; // 0..1
  const saturate = (1 + 0.8 * level).toFixed(2);
  const contrast = (1 + 0.25 * level).toFixed(2);
  const brightness = (1 - 0.06 * level).toFixed(2);
  player.style.filter =
    `saturate(${saturate}) contrast(${contrast}) brightness(${brightness})`;
}

/** Enruta el audio del reproductor diferido a la salida elegida. */
async function applyOutputDevice() {
  const deviceId = $("output-select").value;
  try {
    await $("player").setSinkId(deviceId === "default" ? "" : deviceId);
  } catch (err) {
    setStatus(`⚠ No se pudo cambiar la salida: ${err.message}`);
  }
}

function wireEvents() {
  $("btn-refresh-sources").addEventListener("click", refreshSources);
  $("btn-toggle").addEventListener("click", () => (state.running ? stop() : start()));

  $("btn-show-key").addEventListener("click", () => {
    const input = $("api-key");
    input.type = input.type === "password" ? "text" : "password";
  });
  $("api-key").addEventListener("change", async () => {
    if (!state.apiKeyFromEnv) await window.namasub.setApiKey($("api-key").value);
  });

  for (const id of ["delay", "vad-threshold", "vad-prefix", "vad-silence"]) {
    $(id).addEventListener("input", syncSliderLabels);
  }
  $("delay").addEventListener("change", () => prefs.save({ delay: $("delay").value }));
  $("model-select").addEventListener("change", () =>
    prefs.save({ model: $("model-select").value })
  );
  $("bilingual").addEventListener("change", () =>
    prefs.save({ bilingual: $("bilingual").checked })
  );

  // VAD en caliente, como applyVAD() en iOS (server o local según motor)
  for (const id of ["vad-threshold", "vad-prefix", "vad-silence"]) {
    $(id).addEventListener("change", () => {
      prefs.save({
        vadThreshold: $("vad-threshold").value,
        vadPrefix: $("vad-prefix").value,
        vadSilence: $("vad-silence").value,
      });
      state.realtime?.updateVAD(currentVad());
      state.localVad?.configure(localVadOpts());
    });
  }

  $("camera-select").addEventListener("change", () => {
    if ($("camera-select").value) {
      $("source-grid")
        .querySelectorAll(".source-item")
        .forEach((el) => el.classList.remove("selected"));
    }
  });

  $("output-select").addEventListener("change", async () => {
    prefs.save({ outputDevice: $("output-select").value });
    await applyOutputDevice();
  });

  // Corrección de color para capturas de escritorios HDR (solo afecta la
  // visualización en la app, no lo que se guarda en el WebM).
  $("hdr-fix").addEventListener("change", () => {
    prefs.save({ hdrFix: $("hdr-fix").checked });
    applyHdrFilter();
  });
  $("hdr-level").addEventListener("input", () => {
    $("hdr-level-label").textContent = $("hdr-level").value;
    applyHdrFilter();
  });
  $("hdr-level").addEventListener("change", () =>
    prefs.save({ hdrLevel: $("hdr-level").value })
  );

  // Motor de transliteración y sus opciones (persisten; aplican al iniciar).
  $("engine-select").addEventListener("change", () => {
    prefs.save({ engine: $("engine-select").value });
    applyEngineVisibility();
  });
  $("translate-model-select").addEventListener("change", () =>
    prefs.save({ translateModel: $("translate-model-select").value })
  );
  $("lt-delay").addEventListener("change", () => prefs.save({ ltDelay: $("lt-delay").value }));
  $("lt-prompt").addEventListener("change", () => prefs.save({ ltPrompt: $("lt-prompt").value }));
  $("lt-keywords").addEventListener("change", () =>
    prefs.save({ ltKeywords: $("lt-keywords").value })
  );

  // Recorte de la fuente: persiste; se aplica al iniciar la sesión.
  for (const id of ["crop-top", "crop-bottom", "crop-left", "crop-right"]) {
    $(id).addEventListener("change", () => prefs.save({ crop: currentCrop() }));
  }

  // Estilo de subtítulos: se aplica en vivo y se persiste al soltar el control.
  $("sub-font").addEventListener("input", applySubtitleStyle);
  $("sub-font").addEventListener("change", () =>
    prefs.save({ subFont: $("sub-font").value })
  );
  for (const id of ["sub-size", "sub-bg"]) {
    $(id).addEventListener("input", applySubtitleStyle);
    $(id).addEventListener("change", () =>
      prefs.save({ subSize: $("sub-size").value, subBg: $("sub-bg").value })
    );
  }

  $("debug-mode").addEventListener("change", () => {
    const on = $("debug-mode").checked;
    $("debug-panel").classList.toggle("hidden", !on);
    prefs.save({ debug: on });
    if (on) {
      $("debug-log").textContent = dbg.lines.slice(-200).join("\n");
      dbg.log("app", "Modo debug activado");
    }
  });
  $("btn-copy-log").addEventListener("click", async () => {
    // Vía IPC del proceso principal: navigator.clipboard está bloqueado por
    // el handler de permisos de la ventana.
    await window.namasub.copyText(dbg.text());
    setStatus("Registro copiado al portapapeles");
  });
  $("btn-save-log").addEventListener("click", async () => {
    const path = await window.namasub.saveLog(dbg.text());
    if (path) setStatus(`Registro guardado: ${path}`);
  });

  $("btn-export-srt").addEventListener("click", exportSrt);

  window.namasub.onFullscreen((isFull) =>
    document.body.classList.toggle("fullscreen", isFull)
  );
}

/** Muestra las opciones del motor seleccionado y oculta las del otro. */
function applyEngineVisibility() {
  const lt = $("engine-select").value === "livetranscribe";
  $("engine-lt-opts").classList.toggle("hidden", !lt);
  $("engine-realtime-opts").classList.toggle("hidden", lt);
}

function currentCrop() {
  const value = (id) =>
    Math.max(0, parseInt($(id).value, 10) || 0);
  return {
    top: value("crop-top"),
    bottom: value("crop-bottom"),
    left: value("crop-left"),
    right: value("crop-right"),
  };
}

function currentVad() {
  return {
    threshold: parseFloat($("vad-threshold").value),
    prefixMs: parseInt($("vad-prefix").value, 10),
    silenceMs: parseInt($("vad-silence").value, 10),
  };
}

/** Traduce los sliders de VAD (pensados para el server_vad 0..1) a los
 *  parámetros del VAD local por RMS: 0.5 en el slider ≈ RMS 0.03. */
function localVadOpts() {
  const v = currentVad();
  return {
    threshold: v.threshold * 0.06,
    prefixMs: v.prefixMs,
    silenceMs: Math.max(250, v.silenceMs),
  };
}

function setStatus(text) {
  $("status").textContent = text;
}

// ---------------------------------------------------------------------------
// Inicio / detención de la sesión
// ---------------------------------------------------------------------------

async function start() {
  const apiKey = $("api-key").value.trim();
  if (!apiKey) {
    setStatus("⚠ Ingresa tu API Key de OpenAI");
    return;
  }

  const cameraId = $("camera-select").value;
  const video = cameraId
    ? { kind: "camera", deviceId: cameraId }
    : state.selectedSource;
  if (!video) {
    setStatus("⚠ Elige una fuente de video");
    return;
  }
  const audioSel = $("audio-select").value;
  const audio =
    audioSel === "system" ? { kind: "system" } : { kind: "device", deviceId: audioSel };

  $("btn-toggle").disabled = true;
  setStatus("Preparando captura…");

  dbg.log("app", `Iniciando: video=${JSON.stringify(video)} audio=${JSON.stringify(audio)}`);

  try {
    state.stream = await buildStream(video, audio, {
      desktopAudioId: state.selectedSource?.id,
    });
  } catch (err) {
    dbg.log("app", `buildStream falló: ${err.name}: ${err.message}`);
    setStatus(`⚠ No se pudo capturar: ${err.message}`);
    $("btn-toggle").disabled = false;
    return;
  }

  dbg.log(
    "app",
    `Stream listo: ${state.stream.getVideoTracks().length} video, ` +
      `${state.stream.getAudioTracks().length} audio ` +
      `(${state.stream.getAudioTracks()[0]?.label || "sin pista de audio"})`
  );

  // Recorte de la fuente (quitar barra de título, bordes, barras de control).
  const crop = currentCrop();
  if (crop.top + crop.bottom + crop.left + crop.right > 0) {
    state.stream = cropStream(state.stream, crop);
    dbg.log("app", `Recorte aplicado: ${JSON.stringify(crop)}`);
  }

  if (state.stream.getAudioTracks().length === 0) {
    setStatus("⚠ La fuente no entrega audio; revisa el origen de audio");
    state.stream.stopAll?.();
    $("btn-toggle").disabled = false;
    return;
  }

  // Grabación a archivo (opcional)
  state.recordingPath = null;
  if ($("record-file").checked) {
    state.recordingPath = await window.namasub.startRecordingFile();
    if (!state.recordingPath) $("record-file").checked = false;
  }

  // Línea de tiempo + motor de transliteración
  state.timeline = new SubtitleTimeline();
  state.timeline.onDebug = (msg) => dbg.log("subs", msg);
  state.sessionBaseMs = 0;
  state.pendingCommits = [];
  state.itemWindows = new Map();
  state.deltaCount = 0;

  const engine = $("engine-select").value;
  if (engine === "livetranscribe") {
    // Motor nuevo: sesión de solo transcripción (gpt-live-transcribe) +
    // traductor REST secuencial con contexto rodante, como en la app iOS.
    const keywords = $("lt-keywords").value
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    state.realtime = new RealtimeService({
      apiKey,
      mode: "transcribe",
      delay: $("lt-delay").value,
      prompt: $("lt-prompt").value.trim(),
      keywords,
      ...vadOpts(),
    });
    state.translator = new TranslationQueue(apiKey, $("translate-model-select").value);
    state.translator.onDebug = (msg) => dbg.log("trad", msg);
    // La cola emite el mismo ciclo de eventos que las respuestas del motor
    // clásico: la línea de tiempo no distingue quién traduce.
    state.translator.onStarted = () => handleRealtimeEvent("responseStarted");
    state.translator.onToken = (token) => handleRealtimeEvent("outputTextDelta", token);
    state.translator.onCompleted = () => handleRealtimeEvent("responseCompleted");
    state.translator.onError = (msg) => handleRealtimeEvent("error", msg);
    // gpt-live-transcribe no acepta VAD de servidor: los turnos se fechan
    // con un VAD local por energía sobre el mismo audio que va a la API.
    state.localVad = new LocalVad(localVadOpts());
    dbg.log("app", `Motor: gpt-live-transcribe (delay=${$("lt-delay").value}) + ${state.translator.model}, VAD local`);
  } else {
    state.realtime = new RealtimeService({ apiKey, model: $("model-select").value, ...vadOpts() });
    dbg.log("app", `Motor: realtime clásico (${$("model-select").value})`);
  }
  state.realtime.onEvent = handleRealtimeEvent;
  state.realtime.onDebug = (tag, msg) => dbg.log(tag, msg);
  state.realtime.connect();

  // Audio en vivo → PCM16 24 kHz → Realtime
  await startAudioPipe();

  // Reproducción diferida
  const delayMs = parseInt($("delay").value, 10) * 1000;
  state.player = new DelayedPlayer($("player"), state.stream, {
    delayMs,
    onChunk: state.recordingPath
      ? (buf) => window.namasub.appendRecordingChunk(buf)
      : null,
    onState: onPlayerState,
  });
  await state.player.start();

  // Bucles de render, traductor de respaldo y estadísticas de depuración
  state.renderTimer = requestAnimationFrame(renderLoop);
  state.fallbackTimer = setInterval(runFallback, 1500);
  state.debugTimer = setInterval(updateDebugStats, 1000);

  state.running = true;
  $("btn-toggle").disabled = false;
  $("btn-toggle").textContent = "■ Detener";
  $("btn-toggle").classList.add("running");
  $("btn-export-srt").disabled = true;
  $("stage-hint").classList.add("hidden");
  setStatus("🎧 Escuchando…");
}

function vadOpts() {
  const v = currentVad();
  return {
    vadThreshold: v.threshold,
    vadPrefixMs: v.prefixMs,
    vadSilenceMs: v.silenceMs,
  };
}

async function stop() {
  dbg.log("app", "Deteniendo sesión");
  state.running = false;
  cancelAnimationFrame(state.renderTimer);
  clearInterval(state.fallbackTimer);
  clearInterval(state.debugTimer);

  state.realtime?.disconnect();
  state.realtime = null;
  state.translator?.stop();
  state.translator = null;
  state.localVad = null;

  if (state.workletNode) {
    state.workletNode.disconnect();
    state.workletNode = null;
  }
  if (state.audioCtx) {
    await state.audioCtx.close().catch(() => {});
    state.audioCtx = null;
  }

  await state.player?.stop();
  state.player = null;

  if (state.recordingPath) {
    await window.namasub.stopRecordingFile();
    setStatus(`Grabación guardada: ${state.recordingPath}`);
  } else {
    setStatus("Detenido");
  }

  state.stream?.stopAll?.();
  state.stream = null;

  $("btn-toggle").textContent = "▶ Iniciar";
  $("btn-toggle").classList.remove("running");
  $("btn-export-srt").disabled = !state.timeline || state.timeline.entries.length === 0;
  $("buffer-badge").classList.add("hidden");
  $("stage-hint").classList.remove("hidden");
  hideSubtitles();
}

// ---------------------------------------------------------------------------
// Audio en vivo → Realtime API
// ---------------------------------------------------------------------------

async function startAudioPipe() {
  // AudioContext a 24 kHz: Chromium remuestrea la fuente automáticamente.
  state.audioCtx = new AudioContext({ sampleRate: 24000 });
  await state.audioCtx.audioWorklet.addModule("worklets/pcm16.js");

  const audioOnly = new MediaStream(state.stream.getAudioTracks());
  const source = state.audioCtx.createMediaStreamSource(audioOnly);
  state.workletNode = new AudioWorkletNode(state.audioCtx, "pcm16");
  state.workletNode.port.onmessage = (event) => {
    // Nivel RMS del bloque para el medidor de depuración: si se queda en 0,
    // la fuente de audio no está entregando señal.
    const samples = new Int16Array(event.data);
    let sum = 0;
    for (let i = 0; i < samples.length; i += 8) sum += samples[i] * samples[i];
    dbg.lastRms = Math.sqrt(sum / (samples.length / 8)) / 32768;

    // Motor Live-Transcribe: el VAD local fecha los turnos con el reloj de
    // captura Y cierra el buffer de audio del servidor (sin VAD de servidor,
    // nadie más hace commit y el modelo nunca emitiría transcripciones).
    if (state.localVad && state.timeline) {
      const nowMs = state.player?.captureTimeMs() ?? 0;
      const vadEvent = state.localVad.update(dbg.lastRms, nowMs);
      if (vadEvent?.type === "start") {
        state.timeline.speechStarted(vadEvent.ms);
        state.lastSpeechStartMs = vadEvent.ms;
      } else if (vadEvent?.type === "stop") {
        state.timeline.speechStopped(vadEvent.ms);
        // Turnos de ≥250 ms: los más cortos son ruido y el commit de un
        // buffer casi vacío provoca errores del servidor.
        if (vadEvent.ms - (state.lastSpeechStartMs ?? 0) >= 250) {
          // Registra la ventana del turno que este commit cierra: el server
          // responderá con un item_id y la transcripción llegará con él.
          state.pendingCommits.push({
            startMs: state.lastSpeechStartMs ?? 0,
            endMs: vadEvent.ms,
          });
          state.realtime?.commitAudio();
        }
      }
    }

    state.realtime?.sendAudio(event.data);
  };
  dbg.log("app", `Pipe de audio listo (AudioContext ${state.audioCtx.sampleRate} Hz)`);
  // El worklet no produce salida audible; se conecta solo para mantenerlo vivo.
  source.connect(state.workletNode);
}

// ---------------------------------------------------------------------------
// Eventos Realtime → línea de tiempo
// ---------------------------------------------------------------------------

function handleRealtimeEvent(type, payload) {
  const t = state.timeline;
  if (!t) return;
  if (type !== "outputTextDelta" && type !== "inputTranscriptDelta") {
    const detail =
      typeof payload === "string"
        ? payload.slice(0, 120)
        : payload == null
          ? ""
          : JSON.stringify(payload).slice(0, 120);
    dbg.log("evt", `${type} ${detail}`);
  }
  switch (type) {
    case "connected":
      // Nueva sesión (inicio o reconexión): su reloj de audio parte de 0.
      state.sessionBaseMs = state.player?.captureTimeMs() ?? 0;
      if (state.sessionBaseMs > 0) {
        dbg.log("app", `Sesión reconectada; base de tiempo ${Math.round(state.sessionBaseMs)}ms`);
      }
      if (state.running) setStatus("🎧 Escuchando…");
      break;
    case "speechStarted":
      t.speechStarted(
        payload != null
          ? payload + state.sessionBaseMs
          : state.player?.captureTimeMs() ?? 0
      );
      break;
    case "speechStopped":
      t.speechStopped(
        payload != null
          ? payload + state.sessionBaseMs
          : state.player?.captureTimeMs() ?? 0
      );
      break;
    case "bufferCommitted": {
      // Empareja el commit más antiguo pendiente con el item que creó.
      const win = state.pendingCommits.shift();
      if (win && payload) state.itemWindows.set(payload, win);
      break;
    }
    case "inputTranscript": {
      const text = typeof payload === "string" ? payload : payload?.text;
      if (!text) break; // ignora transcripciones vacías (ruido)
      const itemId = typeof payload === "object" ? payload?.itemId : null;
      const win = itemId ? state.itemWindows.get(itemId) : null;
      if (win) {
        // Emparejamiento exacto por item_id (motor Live-Transcribe).
        t.inputTranscriptAt(win.startMs, win.endMs, text);
        state.itemWindows.delete(itemId);
      } else {
        t.inputTranscript(text);
      }
      // Motor Live-Transcribe: cada turno japonés completado va a la cola
      // de traducción (en el clásico traduce la propia sesión realtime).
      state.translator?.push(text);
      break;
    }
    case "inputTranscriptDelta":
      // Solo visibilidad: confirma en el debug que la transcripción fluye.
      state.deltaCount += 1;
      if (state.deltaCount === 1 || state.deltaCount % 25 === 0) {
        dbg.log("rx", `transcripción fluyendo (${state.deltaCount} deltas)`);
      }
      break;
    case "responseStarted":
      t.responseStarted();
      setStatus("🌐 Traduciendo…");
      break;
    case "outputTextDelta":
      t.outputTextDelta(payload);
      break;
    case "responseCompleted":
      t.responseCompleted();
      if (state.running) setStatus("🎧 Escuchando…");
      break;
    case "error":
      setStatus(`⚠ ${payload}`);
      break;
    case "disconnected":
      if (state.running) setStatus("⚠ Conexión cerrada");
      break;
  }
}

/** Red de seguridad: traduce por REST los turnos que quedaron sin traducción. */
async function runFallback() {
  if (!state.running || !state.timeline) return;
  const apiKey = $("api-key").value.trim();
  const nowMs = state.player?.captureTimeMs() ?? 0;
  for (const entry of state.timeline.pendingFallback(nowMs)) {
    entry.spanish = "…"; // evita reintentos concurrentes
    const es = await fallbackTranslate(apiKey, entry.japanese);
    entry.spanish = "";
    state.timeline.fillFallback(entry, es);
    if (!es) entry.done = true; // no insistir con esta línea
  }
}

// ---------------------------------------------------------------------------
// Render de la capa de subtítulos sobre el video diferido
// ---------------------------------------------------------------------------

function renderLoop() {
  if (!state.running) return;
  const mediaMs = state.player?.mediaTimeMs() ?? 0;
  const entry = state.timeline?.activeAt(mediaMs);

  if (entry && (entry.spanish || entry.japanese)) {
    const showJp = $("bilingual").checked && entry.japanese;
    setLine($("sub-jp"), showJp ? entry.japanese : "");
    setLine($("sub-es"), entry.spanish || (showJp ? "" : entry.japanese));
  } else {
    hideSubtitles();
  }
  state.renderTimer = requestAnimationFrame(renderLoop);
}

function setLine(el, text) {
  const clean = (text || "").trim();
  el.textContent = clean;
  el.classList.toggle("visible", clean.length > 0);
}

function hideSubtitles() {
  setLine($("sub-jp"), "");
  setLine($("sub-es"), "");
}

/** Línea de estadísticas + medidor de audio del panel de depuración. */
function updateDebugStats() {
  if ($("debug-panel").classList.contains("hidden")) return;
  const capture = state.player?.captureTimeMs() ?? 0;
  const media = state.player?.mediaTimeMs() ?? 0;
  const lag = capture - media;
  const entries = state.timeline?.entries.length ?? 0;
  const translated =
    state.timeline?.entries.filter((e) => e.spanish).length ?? 0;
  $("debug-stats").textContent =
    `vivo ${(capture / 1000).toFixed(1)}s · video ${(media / 1000).toFixed(1)}s · ` +
    `atraso ${(lag / 1000).toFixed(1)}s · subs ${translated}/${entries}`;
  $("audio-meter-fill").style.width =
    `${Math.min(100, Math.round(dbg.lastRms * 300))}%`;
}

function onPlayerState(stateTxt) {
  const badge = $("buffer-badge");
  if (stateTxt.startsWith("buffering:")) {
    const remaining = Math.ceil(parseInt(stateTxt.split(":")[1], 10) / 1000);
    badge.textContent = `⏳ Diferido: el video comienza en ${remaining} s`;
    badge.classList.remove("hidden");
  } else {
    if (stateTxt === "playing") dbg.log("player", "Reproducción diferida iniciada");
    badge.textContent = "";
    badge.classList.add("hidden");
  }
}

// ---------------------------------------------------------------------------
// Exportar SRT
// ---------------------------------------------------------------------------

async function exportSrt() {
  if (!state.timeline) return;
  const srt = state.timeline.toSrt({ bilingual: $("bilingual").checked });
  if (!srt.trim()) {
    setStatus("No hay subtítulos que exportar");
    return;
  }
  const path = await window.namasub.saveSrt(srt, "namasub.srt");
  if (path) setStatus(`SRT exportado: ${path}`);
}

init();
