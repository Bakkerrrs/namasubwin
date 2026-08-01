// Cliente de la Realtime API de OpenAI por WebSocket.
// Puerto casi 1:1 de RealtimeService.swift de la app iOS: mismos payloads de
// session.update, mismos parámetros de VAD y mismo prompt de traducción JP→ES.
// Se añaden los eventos de VAD (speech_started/stopped) porque en Windows los
// usamos para fechar cada subtítulo contra el reloj de captura.

export const REALTIME_MODELS = [
  "gpt-realtime",
  "gpt-realtime-2",
  "gpt-4o-realtime-preview",
];

const TRANSLATE_INSTRUCTIONS = `Eres un traductor profesional de japonés a español. \
Por cada intervención del usuario en japonés, responde ÚNICAMENTE con su \
traducción al español, de forma natural y fluida, manteniendo el tono y \
registro del original. Adapta onomatopeyas y expresiones culturales al \
equivalente más cercano en español. No converses, no expliques, no \
agregues comentarios: devuelve solo la traducción.`;

export class RealtimeService {
  /**
   * @param {object} opts
   *   {apiKey, model, vadThreshold, vadPrefixMs, vadSilenceMs,
   *    mode: "translate" (clásico: el modelo realtime traduce) |
   *          "transcribe" (sesión de solo transcripción con gpt-live-transcribe),
   *    transcribeModel, languages, prompt, keywords, delay}   // solo mode transcribe
   */
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || REALTIME_MODELS[0];
    this.mode = opts.mode || "translate";
    this.transcribeModel = opts.transcribeModel || "gpt-live-transcribe";
    this.languages = opts.languages || ["ja"];
    this.contextPrompt = opts.prompt || "";
    this.keywords = opts.keywords || [];
    this.delay = opts.delay || "high";
    this.vadThreshold = opts.vadThreshold ?? 0.5;
    this.vadPrefixMs = opts.vadPrefixMs ?? 200;
    this.vadSilenceMs = opts.vadSilenceMs ?? 250;

    this.ws = null;
    /** Callback de eventos: (type, payload) => void. Tipos:
     *  connected | disconnected | error(msg)
     *  speechStarted(ms) | speechStopped(ms)
     *  inputTranscript(text) | responseStarted | outputTextDelta(token) |
     *  responseCompleted
     */
    this.onEvent = () => {};
    /** Callback de depuración: (dirección "tx"|"rx"|"ws", detalle) => void. */
    this.onDebug = () => {};
    this._audioChunksSent = 0;

    // Reconexión automática: las sesiones Realtime tienen duración máxima y
    // la red puede cortarse; sin esto los subtítulos morían en silencio.
    this.autoReconnect = true;
    this._manualClose = false;
    this._reconnectDelayMs = 1000;
    this._reconnectTimer = 0;
  }

  connect() {
    this._manualClose = false;
    // Modo transcripción: sesión dedicada (intent=transcription), el modelo
    // va en el session.update. Modo clásico: el modelo va en la URL.
    const url =
      this.mode === "transcribe"
        ? "wss://api.openai.com/v1/realtime?intent=transcription"
        : `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;
    // El navegador no permite headers en WebSocket: la Realtime API acepta la
    // key por subprotocolo (openai-insecure-api-key), pensado justo para esto.
    // OJO: sin el subprotocolo beta — los payloads son del formato GA, el
    // mismo que usa la app iOS.
    this.onDebug("ws", `Conectando a ${url}`);
    this.ws = new WebSocket(url, [
      "realtime",
      `openai-insecure-api-key.${this.apiKey}`,
    ]);

    this.ws.onopen = () => {
      this.onDebug("ws", `Conectado (subprotocolo: ${this.ws.protocol || "—"})`);
      this._reconnectDelayMs = 1000; // conexión sana: reinicia el backoff
      this._sendSessionUpdate();
      this.onEvent("connected");
    };
    this.ws.onmessage = (event) => this._handle(event.data);
    this.ws.onerror = () => {
      this.onDebug("ws", "onerror del WebSocket");
      this.onEvent("error", "Error de conexión Realtime");
    };
    this.ws.onclose = (event) => {
      this.onDebug("ws", `Cerrado: código ${event.code} ${event.reason || ""}`);
      this.onEvent("disconnected");
      this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    if (this._manualClose || !this.autoReconnect) return;
    const delay = this._reconnectDelayMs;
    this._reconnectDelayMs = Math.min(delay * 2, 15000);
    this.onDebug("ws", `Reconectando en ${delay} ms…`);
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (!this._manualClose) this.connect();
    }, delay);
  }

  disconnect() {
    this._manualClose = true;
    clearTimeout(this._reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close(1000);
      this.ws = null;
    }
    this.onEvent("disconnected");
  }

  /** Envía un bloque de audio PCM16 24 kHz mono (ArrayBuffer). */
  sendAudio(arrayBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    this._send({ type: "input_audio_buffer.append", audio: btoa(binary) }, true);
    this._audioChunksSent += 1;
    if (this._audioChunksSent % 100 === 0) {
      this.onDebug("tx", `${this._audioChunksSent} bloques de audio enviados`);
    }
  }

  /** Cierra el turno de audio en curso (modo transcripción sin VAD de
   *  servidor: si nadie hace commit, el modelo nunca emite transcripciones).
   *  Lo invoca el VAD local al detectar el fin de cada turno de voz. */
  commitAudio() {
    if (this.mode !== "transcribe") return;
    this._send({ type: "input_audio_buffer.commit" });
  }

  /** Actualiza los parámetros de VAD en caliente (sin reconectar).
   *  En modo transcripción no hay VAD de servidor (lo lleva el VAD local). */
  updateVAD({ threshold, prefixMs, silenceMs }) {
    this.vadThreshold = threshold;
    this.vadPrefixMs = prefixMs;
    this.vadSilenceMs = silenceMs;
    if (this.mode === "transcribe") return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendSessionUpdate();
    }
  }

  _sendSessionUpdate() {
    if (this.mode === "transcribe") {
      this._send({
        type: "session.update",
        session: {
          type: "transcription",
          audio: { input: this._audioInputConfig() },
        },
      });
      return;
    }
    this._send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: TRANSLATE_INSTRUCTIONS,
        output_modalities: ["text"],
        audio: { input: this._audioInputConfig() },
      },
    });
  }

  _audioInputConfig() {
    const turnDetection = {
      type: "server_vad",
      threshold: this.vadThreshold,
      prefix_padding_ms: this.vadPrefixMs,
      silence_duration_ms: this.vadSilenceMs,
    };

    if (this.mode === "transcribe") {
      // gpt-live-transcribe acepta contexto para mejorar la precisión:
      // prompt libre, keywords literales, idiomas esperados y el knob
      // delay (más alto = más preciso; el buffer diferido lo absorbe).
      // OJO: turn_detection debe ir en null — el modelo segmenta solo y
      // rechaza el VAD de servidor; los timestamps salen del VAD local.
      const transcription = {
        model: this.transcribeModel,
        languages: this.languages,
        delay: this.delay,
      };
      if (this.contextPrompt) transcription.prompt = this.contextPrompt;
      if (this.keywords.length > 0) transcription.keywords = this.keywords;
      return {
        format: { type: "audio/pcm", rate: 24000 },
        turn_detection: null,
        transcription,
      };
    }

    return {
      format: { type: "audio/pcm", rate: 24000 },
      turn_detection: { ...turnDetection, create_response: true },
      transcription: { model: "gpt-4o-mini-transcribe", language: "ja" },
    };
  }

  _handle(text) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return;
    }
    switch (obj.type) {
      case "input_audio_buffer.speech_started":
        this.onEvent("speechStarted", obj.audio_start_ms ?? null);
        break;
      case "input_audio_buffer.speech_stopped":
        this.onEvent("speechStopped", obj.audio_end_ms ?? null);
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (obj.transcript) {
          this.onEvent("inputTranscript", {
            text: obj.transcript.trim(),
            itemId: obj.item_id || null,
          });
        }
        break;
      case "input_audio_buffer.committed":
        // Permite mapear cada commit del VAD local a su item del servidor
        // (emparejamiento exacto de ventanas de tiempo).
        this.onEvent("bufferCommitted", obj.item_id || null);
        break;
      case "conversation.item.input_audio_transcription.delta":
        // Parciales: el completed trae el turno entero. Se emiten para que la
        // app confirme en debug que la transcripción fluye (throttled allá).
        if (obj.delta) this.onEvent("inputTranscriptDelta", obj.delta);
        break;
      case "response.created":
        this.onEvent("responseStarted");
        break;
      case "response.output_text.delta":
        if (obj.delta) this.onEvent("outputTextDelta", obj.delta);
        break;
      case "response.done":
      case "response.completed":
        this.onEvent("responseCompleted");
        break;
      case "error":
        this.onDebug("rx", `ERROR: ${JSON.stringify(obj.error || obj)}`);
        this.onEvent("error", obj.error?.message || "Error de Realtime");
        break;
      default:
        // Otros eventos del ciclo de vida: visibles en modo debug para
        // detectar discrepancias de nombres entre versiones de la API.
        this.onDebug("rx", `${obj.type} ${JSON.stringify(obj).slice(0, 180)}`);
        break;
    }
  }

  _send(payload, quiet = false) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      if (!quiet) this.onDebug("tx", JSON.stringify(payload).slice(0, 300));
    } else if (!quiet) {
      this.onDebug("tx", `descartado (WS no abierto): ${payload.type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Traductor de respaldo (puerto de FallbackTranslator.swift): traduce por REST
// las líneas japonesas que el canal Realtime transcribió pero no tradujo.
// ---------------------------------------------------------------------------

export const FALLBACK_MODEL = "gpt-5.6-luna";

export async function fallbackTranslate(apiKey, japanese) {
  const text = (japanese || "").trim();
  if (!text) return null;

  const system = `Eres un traductor profesional de japonés a español. Traduce el texto \
japonés al español de forma natural y fluida. Responde SOLO con la \
traducción, sin explicaciones ni comillas.`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: FALLBACK_MODEL,
        reasoning_effort: "none",
        messages: [
          { role: "system", content: system },
          { role: "user", content: text },
        ],
        max_completion_tokens: 800,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}
