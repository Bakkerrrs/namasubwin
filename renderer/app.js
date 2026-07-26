// Orquestación de la app (equivalente al TranslatorViewModel de iOS):
// fuente → captura → [reproducción diferida] + [audio → Realtime API] →
// línea de tiempo de subtítulos → capa quemada sobre el video.

import {
  listCameras,
  listAudioInputs,
  listAudioOutputs,
  warmUpPermissions,
  buildStream,
} from "./capture.js";
import { DelayedPlayer } from "./delaybuffer.js";
import { RealtimeService, REALTIME_MODELS, fallbackTranslate } from "./realtime.js";
import { SubtitleTimeline } from "./subtitles.js";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

const state = {
  running: false,
  selectedSource: null, // {kind:"screen"|"window", id} de la grilla
  stream: null,
  player: null,         // DelayedPlayer
  realtime: null,       // RealtimeService
  timeline: null,       // SubtitleTimeline
  audioCtx: null,
  workletNode: null,
  recordingPath: null,
  fallbackTimer: 0,
  renderTimer: 0,
  apiKeyFromEnv: false,
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
  // Modelos Realtime
  for (const model of REALTIME_MODELS) {
    const opt = document.createElement("option");
    opt.value = model;
    opt.textContent = model;
    $("model-select").appendChild(opt);
  }

  // Preferencias guardadas
  const saved = prefs.load();
  if (saved.model && REALTIME_MODELS.includes(saved.model)) {
    $("model-select").value = saved.model;
  }
  if (saved.delay) $("delay").value = saved.delay;
  if (saved.vadThreshold) $("vad-threshold").value = saved.vadThreshold;
  if (saved.vadPrefix) $("vad-prefix").value = saved.vadPrefix;
  if (saved.vadSilence) $("vad-silence").value = saved.vadSilence;
  if (saved.bilingual) $("bilingual").checked = true;
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

  // VAD en caliente, como applyVAD() en iOS
  for (const id of ["vad-threshold", "vad-prefix", "vad-silence"]) {
    $(id).addEventListener("change", () => {
      prefs.save({
        vadThreshold: $("vad-threshold").value,
        vadPrefix: $("vad-prefix").value,
        vadSilence: $("vad-silence").value,
      });
      state.realtime?.updateVAD(currentVad());
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

  $("btn-export-srt").addEventListener("click", exportSrt);

  window.namasub.onFullscreen((isFull) =>
    document.body.classList.toggle("fullscreen", isFull)
  );
}

function currentVad() {
  return {
    threshold: parseFloat($("vad-threshold").value),
    prefixMs: parseInt($("vad-prefix").value, 10),
    silenceMs: parseInt($("vad-silence").value, 10),
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

  try {
    state.stream = await buildStream(video, audio, {
      desktopAudioId: state.selectedSource?.id,
    });
  } catch (err) {
    setStatus(`⚠ No se pudo capturar: ${err.message}`);
    $("btn-toggle").disabled = false;
    return;
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

  // Línea de tiempo + Realtime
  state.timeline = new SubtitleTimeline();
  state.realtime = new RealtimeService({ apiKey, model: $("model-select").value, ...vadOpts() });
  state.realtime.onEvent = handleRealtimeEvent;
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

  // Bucles de render y de traductor de respaldo
  state.renderTimer = requestAnimationFrame(renderLoop);
  state.fallbackTimer = setInterval(runFallback, 1500);

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
  state.running = false;
  cancelAnimationFrame(state.renderTimer);
  clearInterval(state.fallbackTimer);

  state.realtime?.disconnect();
  state.realtime = null;

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
    state.realtime?.sendAudio(event.data);
  };
  // El worklet no produce salida audible; se conecta solo para mantenerlo vivo.
  source.connect(state.workletNode);
}

// ---------------------------------------------------------------------------
// Eventos Realtime → línea de tiempo
// ---------------------------------------------------------------------------

function handleRealtimeEvent(type, payload) {
  const t = state.timeline;
  if (!t) return;
  switch (type) {
    case "connected":
      if (state.running) setStatus("🎧 Escuchando…");
      break;
    case "speechStarted":
      t.speechStarted(payload ?? state.player?.captureTimeMs() ?? 0);
      break;
    case "speechStopped":
      t.speechStopped(payload ?? state.player?.captureTimeMs() ?? 0);
      break;
    case "inputTranscript":
      if (payload) t.inputTranscript(payload); // ignora transcripciones vacías (ruido)
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

function onPlayerState(stateTxt) {
  const badge = $("buffer-badge");
  if (stateTxt.startsWith("buffering:")) {
    const remaining = Math.ceil(parseInt(stateTxt.split(":")[1], 10) / 1000);
    badge.textContent = `⏳ Diferido: el video comienza en ${remaining} s`;
    badge.classList.remove("hidden");
  } else {
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
