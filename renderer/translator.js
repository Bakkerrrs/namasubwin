// Traductor JP→ES por REST con streaming — puerto de OpenAIService.swift de
// la app iOS: mismo system prompt, mismo contexto rodante de 5 pares JP/ES.
//
// Se usa con el motor "GPT-Live-Transcribe": la sesión realtime solo
// transcribe, y cada turno japonés completado se traduce aquí. La cola es
// secuencial (un turno a la vez, en orden) para que los tokens lleguen a la
// línea de tiempo en el mismo orden que los turnos — el buffer diferido
// absorbe de sobra la latencia extra.

/** Modelos de texto para traducir. gpt-5.6 es la generación vigente
 *  (jul-2026); Luna es la más rápida/barata y suficiente para frases cortas. */
export const TRANSLATE_MODELS = [
  "gpt-5.6-luna",   // más rápido y barato (recomendado)
  "gpt-5.6-terra",  // equilibrado
  "gpt-5.6-sol",    // máxima calidad (más lento)
  "gpt-4.1-mini",
  "gpt-4o-mini",
];

const SYSTEM_PROMPT = `Eres un traductor profesional de japonés a español. \
Traduce el texto japonés al español de forma natural y fluida. \
Mantén el tono y registro del original. \
Si el texto contiene onomatopeyas o expresiones culturales japonesas, \
adapta al equivalente más cercano en español. \
Responde SOLO con la traducción, sin explicaciones.`;

const CONTEXT_LIMIT = 5;

/**
 * Arma el payload de /v1/chat/completions para traducir `japanese` con el
 * contexto previo. Los gpt-5.x usan razonamiento: se les manda
 * reasoning_effort "none" (y no aceptan temperature); los clásicos llevan
 * temperature 0.3 como en la app iOS. Función pura, probada por unit tests.
 */
export function buildTranslationPayload(model, context, japanese) {
  const contextStr = context.length ? context.join("\n") : "(sin contexto previo)";
  const payload = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Contexto previo de la conversación (SOLO referencia, no lo traduzcas ` +
          `ni lo repitas):\n${contextStr}\n\n` +
          `Traduce al español ÚNICAMENTE este texto y responde solo con su ` +
          `traducción:\n${japanese}`,
      },
    ],
    max_completion_tokens: 500,
    stream: true,
  };
  if (model.startsWith("gpt-5")) {
    payload.reasoning_effort = "none";
  } else {
    payload.temperature = 0.3;
  }
  return payload;
}

export class TranslationQueue {
  constructor(apiKey, model) {
    this.apiKey = apiKey;
    this.model = model || TRANSLATE_MODELS[0];
    this.context = [];
    this._queue = [];
    this._busy = false;
    this._stopped = false;

    // Callbacks (mismo ciclo que las respuestas del motor clásico).
    this.onStarted = () => {};
    this.onToken = () => {};
    this.onCompleted = () => {};
    this.onError = () => {};
    this.onDebug = () => {};
  }

  /** Encola un turno japonés para traducir (FIFO, uno a la vez).
   *  `ref` viaja intacto hasta los callbacks: permite escribir la traducción
   *  directamente en SU entrada de la línea de tiempo, sin heurísticas. */
  push(japanese, ref = null) {
    const text = (japanese || "").trim();
    if (!text) return;
    this._queue.push({ text, ref });
    this.onDebug(`en cola: ${this._queue.length} turno(s)`);
    this._drain();
  }

  stop() {
    this._stopped = true;
    this._queue.length = 0;
  }

  async _drain() {
    if (this._busy || this._stopped) return;
    const job = this._queue.shift();
    if (job == null) return;
    this._busy = true;
    try {
      await this._translate(job.text, job.ref);
    } catch (err) {
      this.onDebug(`traducción falló: ${err.message}`);
      this.onError(err.message, job.ref);
    }
    this._busy = false;
    this._drain();
  }

  async _translate(japanese, ref) {
    this.onStarted(japanese, ref);
    const payload = buildTranslationPayload(this.model, this.context, japanese);

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${body.slice(0, 120)}`);
    }

    // SSE: líneas "data: {...}" con deltas, terminadas por "data: [DONE]".
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // línea posiblemente incompleta
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const token = JSON.parse(data).choices?.[0]?.delta?.content;
          if (token) {
            full += token;
            this.onToken(token, ref);
          }
        } catch {
          /* fragmento no-JSON: ignorar */
        }
      }
    }

    this.context.push(`JP: ${japanese}\nES: ${full}`);
    if (this.context.length > CONTEXT_LIMIT) {
      this.context.splice(0, this.context.length - CONTEXT_LIMIT);
    }
    this.onCompleted(japanese, full.trim(), ref);
  }
}
