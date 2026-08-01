// Línea de tiempo de subtítulos.
//
// Cada turno de habla detectado por el VAD del servidor se convierte en una
// entrada con su ventana [startMs, endMs] medida en el reloj de captura
// (audio_start_ms/audio_end_ms de la Realtime API, que coincide con el reloj
// del video diferido: 0 = instante de Iniciar). Como el video se reproduce
// N segundos atrás, cuando la reproducción alcanza startMs la transcripción y
// la traducción de ese turno ya llegaron: el subtítulo aparece sincronizado.
//
// Módulo puro (sin DOM) para poder probarlo con node --test.

const MIN_DISPLAY_MS = 1800;   // un subtítulo nunca dura menos que esto
const TAIL_MS = 1200;          // margen tras el fin del habla
const CHUNK_MAX_CHARS = 90;    // máx. caracteres por subtítulo en pantalla (~2 líneas)
const CHUNK_MIN_MS = 1400;     // duración mínima de cada trozo de un turno largo

export class SubtitleTimeline {
  constructor() {
    this.entries = [];
    this._openIndex = -1;     // turno cuyo audio sigue en curso
    this._responseIndex = -1; // turno al que se enrutan los tokens de traducción
    /** Registro de decisiones internas (para el modo debug de la app). */
    this.onDebug = () => {};
  }

  // ------------------------------------------------------------------
  // Eventos del RealtimeService (todos en ms de reloj de captura)
  // ------------------------------------------------------------------

  speechStarted(ms) {
    // Recolección de turnos "fantasma": un turno cerrado que nunca recibió
    // transcripción (ruido) quedaría para siempre como "el más antiguo sin
    // traducir" y secuestraría las traducciones de los turnos siguientes,
    // que aterrizarían en una ventana de tiempo ya pasada (subs invisibles).
    // Gracia de 10 s: la transcripción de un turno recién cerrado puede
    // tardar un par de segundos en llegar y no hay que descartarlo antes.
    this.entries.forEach((e, i) => {
      const stale = e.endMs != null && ms - e.endMs > 10_000;
      if (!e.done && stale && !e.japanese && !e.spanish) {
        e.done = true;
        this.onDebug(`turno #${i} vacío (ruido) descartado`);
      }
    });

    this.entries.push({
      startMs: ms,
      endMs: null,
      japanese: "",
      spanish: "",
      done: false,
    });
    this._openIndex = this.entries.length - 1;
    this.onDebug(`turno #${this._openIndex} abre @${Math.round(ms)}ms`);
  }

  speechStopped(ms) {
    if (this._openIndex >= 0 && this.entries[this._openIndex].endMs == null) {
      this.entries[this._openIndex].endMs = ms;
    }
    this._openIndex = -1;
  }

  inputTranscript(text) {
    // Las transcripciones llegan en orden: van al turno abierto más antiguo
    // sin texto (los descartados por la recolección ya no compiten).
    const i = this.entries.findIndex((e) => !e.japanese && !e.done);
    if (i >= 0) {
      this.entries[i].japanese = text;
      this.onDebug(`transcripción → turno #${i}: "${text.slice(0, 40)}"`);
      return this.entries[i];
    }
    // Transcripción sin turno libre (p. ej. llegó antes que su speech_started,
    // o el emparejamiento se desfasó): crea una entrada fechada a continuación
    // del último tiempo conocido para que al menos se muestre.
    let startMs = null;
    for (let j = this.entries.length - 1; j >= 0; j--) {
      const known = this.entries[j].endMs ?? this.entries[j].startMs;
      if (known != null) {
        startMs = known;
        break;
      }
    }
    this.entries.push({
      startMs,
      endMs: startMs != null ? startMs + 2000 : null,
      japanese: text,
      spanish: "",
      done: false,
    });
    this.onDebug(
      `transcripción sin turno libre → entrada nueva #${this.entries.length - 1} ` +
        `@${startMs == null ? "sin fecha" : Math.round(startMs) + "ms"}: "${text.slice(0, 40)}"`
    );
    return this.entries[this.entries.length - 1];
  }

  responseStarted() {
    // Los tokens van al turno más antiguo que aún no tiene traducción.
    this._responseIndex = this.entries.findIndex((e) => !e.spanish && !e.done);
    if (this._responseIndex < 0) this._responseIndex = this.entries.length - 1;
    this.onDebug(`respuesta → turno #${this._responseIndex}`);
  }

  outputTextDelta(token) {
    if (this._responseIndex < 0 || this._responseIndex >= this.entries.length) {
      this.responseStarted();
    }
    if (this._responseIndex >= 0) {
      this.entries[this._responseIndex].spanish += token;
    }
  }

  responseCompleted() {
    if (this._responseIndex >= 0 && this._responseIndex < this.entries.length) {
      const e = this.entries[this._responseIndex];
      e.done = true;
      this.onDebug(
        `turno #${this._responseIndex} listo [${Math.round(e.startMs ?? -1)}–` +
          `${Math.round(e.endMs ?? -1)}ms] jp:${e.japanese.length} es:${e.spanish.length}`
      );
    }
    this._responseIndex = -1;
  }

  /** Rellena con el traductor de respaldo si el Realtime no tradujo. */
  fillFallback(entry, spanish) {
    if (!entry.spanish && spanish) {
      entry.spanish = spanish;
      entry.done = true;
    }
  }

  /** Turnos con japonés pero sin traducción (candidatos al respaldo). */
  pendingFallback(nowMs, graceMs = 2000) {
    return this.entries.filter(
      (e) =>
        e.japanese &&
        !e.spanish &&
        e.endMs != null &&
        nowMs - e.endMs > graceMs
    );
  }

  // ------------------------------------------------------------------
  // Consulta para el render
  // ------------------------------------------------------------------

  /** Ventana visible de una entrada: [startMs, fin extendido]. */
  displayWindow(index) {
    const e = this.entries[index];
    if (e.startMs == null) return null;
    const rawEnd = (e.endMs ?? e.startMs) + TAIL_MS;
    let end = Math.max(rawEnd, e.startMs + MIN_DISPLAY_MS);
    // No pisar el turno siguiente.
    const next = this.entries[index + 1];
    if (next && next.startMs != null && next.startMs > e.startMs) {
      end = Math.min(end, next.startMs);
      end = Math.max(end, e.startMs + MIN_DISPLAY_MS); // pero sin desaparecer al instante
    }
    return [e.startMs, end];
  }

  /**
   * Trozos de presentación de una entrada. Los turnos largos (habla continua
   * sin pausas) llegan como un solo bloque de texto: aquí se parten en
   * subtítulos legibles (≤ CHUNK_MAX_CHARS) repartidos proporcionalmente a lo
   * largo de la ventana del turno, como haría un subtitulador.
   */
  chunksFor(index) {
    const e = this.entries[index];
    const win = this.displayWindow(index);
    if (!win) return null;
    const text = (e.spanish || e.japanese || "").trim();
    if (!text) return null;

    // Cachea una vez que el turno está cerrado y su texto es final.
    if (e.done && e._chunks && e._chunksText === text) return e._chunks;

    const pieces = splitText(text, CHUNK_MAX_CHARS);
    const jpPieces = e.spanish
      ? splitProportional(e.japanese.trim(), pieces)
      : pieces.map(() => "");

    const [start, end] = win;
    const total = pieces.reduce((sum, p) => sum + p.length, 0);
    const span = Math.max(end - start, pieces.length * CHUNK_MIN_MS);
    const chunks = [];
    let cursor = start;
    pieces.forEach((piece, i) => {
      const share = Math.max((piece.length / total) * span, CHUNK_MIN_MS);
      chunks.push({
        startMs: cursor,
        endMs: cursor + share,
        spanish: e.spanish ? piece : "",
        japanese: e.spanish ? jpPieces[i] : piece,
      });
      cursor += share;
    });

    if (e.done) {
      e._chunks = chunks;
      e._chunksText = text;
    }
    return chunks;
  }

  /**
   * Texto activo en el instante `mediaMs` del video diferido, ya troceado
   * para pantalla: {japanese, spanish, streaming} o null.
   */
  activeAt(mediaMs) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const win = this.displayWindow(i);
      if (!win) continue;
      if (win[0] < mediaMs - 120_000) break; // muy atrás: dejar de buscar

      // Turno aún en curso al momento de reproducirse: caption en vivo con la
      // cola del texto acumulado (evita el bloque gigante de golpe).
      const e = this.entries[i];
      if (!e.done && mediaMs >= win[0]) {
        const inWindow = mediaMs < Math.max(win[1], (e.endMs ?? mediaMs + 1) + TAIL_MS);
        if (!inWindow) continue;
        const es = tailOf(e.spanish, CHUNK_MAX_CHARS);
        const jp = tailOf(e.japanese, CHUNK_MAX_CHARS);
        if (!es && !jp) return null;
        return { japanese: es ? jp : "", spanish: es || jp, streaming: true };
      }

      const chunks = this.chunksFor(i);
      if (!chunks) continue;
      // Los trozos pueden extenderse más allá de la ventana base (mínimos de
      // duración); un turno posterior gana porque se itera de atrás adelante.
      if (mediaMs >= chunks[0].startMs && mediaMs < chunks[chunks.length - 1].endMs) {
        const chunk = chunks.find((c) => mediaMs >= c.startMs && mediaMs < c.endMs);
        if (chunk) return { ...chunk, streaming: false };
      }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Exportación SRT
  // ------------------------------------------------------------------

  toSrt({ bilingual = false } = {}) {
    const lines = [];
    let n = 0;
    this.entries.forEach((e, i) => {
      const chunks = this.chunksFor(i);
      if (!chunks) return;
      for (const chunk of chunks) {
        const es = chunk.spanish.trim();
        const jp = chunk.japanese.trim();
        const text = bilingual && jp && es ? `${jp}\n${es}` : es || jp;
        if (!text) continue;
        n += 1;
        lines.push(String(n));
        lines.push(`${srtTime(chunk.startMs)} --> ${srtTime(chunk.endMs)}`);
        lines.push(text);
        lines.push("");
      }
    });
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Troceo de texto
// ---------------------------------------------------------------------------

/** Parte `text` en piezas de hasta `maxChars`, prefiriendo cortes en
 *  puntuación fuerte, luego comas/espacios, y como último recurso por
 *  caracteres (el japonés no usa espacios). */
export function splitText(text, maxChars) {
  const clean = (text || "").trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];

  // Primero por oraciones (puntuación occidental y japonesa).
  const sentences = clean.match(/[^.!?。！？]+[.!?。！？]*/g) || [clean];
  const pieces = [];
  let current = "";
  for (const sentence of sentences) {
    const candidate = current ? current + sentence : sentence;
    if (candidate.trim().length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current.trim()) pieces.push(current.trim());
    current = "";
    // Oración más larga que maxChars: partir por comas/espacios/caracteres.
    let rest = sentence.trim();
    while (rest.length > maxChars) {
      let cut = -1;
      for (const re of [/[、,;:]\s?/g, /\s/g]) {
        let match;
        while ((match = re.exec(rest)) && match.index < maxChars) {
          cut = match.index + match[0].length;
        }
        if (cut > maxChars * 0.4) break; // corte razonable encontrado
      }
      if (cut <= 0) cut = maxChars;
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    current = rest;
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

/** Reparte `text` en tantas piezas como `reference`, proporcional al largo de
 *  cada pieza de referencia (para acompañar el japonés a los trozos de la
 *  traducción). */
function splitProportional(text, reference) {
  const clean = (text || "").trim();
  if (!clean || reference.length <= 1) {
    return reference.map((_, i) => (i === 0 ? clean : ""));
  }
  const total = reference.reduce((sum, p) => sum + p.length, 0);
  const out = [];
  let offset = 0;
  reference.forEach((piece, i) => {
    const isLast = i === reference.length - 1;
    const take = isLast
      ? clean.length - offset
      : Math.round((piece.length / total) * clean.length);
    out.push(clean.slice(offset, offset + take).trim());
    offset += take;
  });
  return out;
}

/** Cola de `text` de hasta `maxChars`, cortada en un límite razonable. */
function tailOf(text, maxChars) {
  const clean = (text || "").trim();
  if (clean.length <= maxChars) return clean;
  let tail = clean.slice(-maxChars);
  // Evita empezar a mitad de palabra si hay un espacio cercano.
  const space = tail.search(/\s/);
  if (space > 0 && space < maxChars * 0.3) tail = tail.slice(space + 1);
  return "…" + tail;
}

/** 61234 → "00:01:01,234" */
export function srtTime(ms) {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const milli = clamped % 1000;
  const pad = (v, w) => String(v).padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(milli, 3)}`;
}
