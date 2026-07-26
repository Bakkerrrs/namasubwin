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
   * @param {object} opts {apiKey, model, vadThreshold, vadPrefixMs, vadSilenceMs}
   */
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || REALTIME_MODELS[0];
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
  }

  connect() {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;
    // El navegador no permite headers en WebSocket: la Realtime API acepta la
    // key por subprotocolo (openai-insecure-api-key), pensado justo para esto.
    this.ws = new WebSocket(url, [
      "realtime",
      `openai-insecure-api-key.${this.apiKey}`,
      "openai-beta.realtime-v1",
    ]);

    this.ws.onopen = () => {
      this._sendSessionUpdate();
      this.onEvent("connected");
    };
    this.ws.onmessage = (event) => this._handle(event.data);
    this.ws.onerror = () => this.onEvent("error", "Error de conexión Realtime");
    this.ws.onclose = () => this.onEvent("disconnected");
  }

  disconnect() {
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
    this._send({ type: "input_audio_buffer.append", audio: btoa(binary) });
  }

  /** Actualiza los parámetros de VAD en caliente (sin reconectar). */
  updateVAD({ threshold, prefixMs, silenceMs }) {
    this.vadThreshold = threshold;
    this.vadPrefixMs = prefixMs;
    this.vadSilenceMs = silenceMs;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendSessionUpdate();
    }
  }

  _sendSessionUpdate() {
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
    return {
      format: { type: "audio/pcm", rate: 24000 },
      turn_detection: {
        type: "server_vad",
        threshold: this.vadThreshold,
        prefix_padding_ms: this.vadPrefixMs,
        silence_duration_ms: this.vadSilenceMs,
        create_response: true,
      },
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
        if (obj.transcript) this.onEvent("inputTranscript", obj.transcript.trim());
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
        this.onEvent("error", obj.error?.message || "Error de Realtime");
        break;
      default:
        break; // otros eventos del ciclo de vida
    }
  }

  _send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
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
