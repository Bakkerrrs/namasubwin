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

const MIN_DISPLAY_MS = 1800; // un subtítulo nunca dura menos que esto
const TAIL_MS = 1200;        // margen tras el fin del habla

export class SubtitleTimeline {
  constructor() {
    this.entries = [];
    this._openIndex = -1;     // turno cuyo audio sigue en curso
    this._responseIndex = -1; // turno al que se enrutan los tokens de traducción
  }

  // ------------------------------------------------------------------
  // Eventos del RealtimeService (todos en ms de reloj de captura)
  // ------------------------------------------------------------------

  speechStarted(ms) {
    this.entries.push({
      startMs: ms,
      endMs: null,
      japanese: "",
      spanish: "",
      done: false,
    });
    this._openIndex = this.entries.length - 1;
  }

  speechStopped(ms) {
    if (this._openIndex >= 0 && this.entries[this._openIndex].endMs == null) {
      this.entries[this._openIndex].endMs = ms;
    }
    this._openIndex = -1;
  }

  inputTranscript(text) {
    // Las transcripciones llegan en orden: van al turno más antiguo sin texto.
    const i = this.entries.findIndex((e) => !e.japanese);
    if (i >= 0) {
      this.entries[i].japanese = text;
      return this.entries[i];
    }
    // Transcripción sin speech_started previo (no debería pasar): crea entrada.
    this.entries.push({
      startMs: null,
      endMs: null,
      japanese: text,
      spanish: "",
      done: false,
    });
    return this.entries[this.entries.length - 1];
  }

  responseStarted() {
    // Los tokens van al turno más antiguo que aún no tiene traducción.
    this._responseIndex = this.entries.findIndex((e) => !e.spanish && !e.done);
    if (this._responseIndex < 0) this._responseIndex = this.entries.length - 1;
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
      this.entries[this._responseIndex].done = true;
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

  /** Entrada activa en el instante `mediaMs` del video diferido (o null). */
  activeAt(mediaMs) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const win = this.displayWindow(i);
      if (!win) continue;
      const [start, end] = win;
      if (mediaMs >= start && mediaMs < end) return this.entries[i];
      if (start < mediaMs - 60_000) break; // muy atrás: dejar de buscar
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
      const win = this.displayWindow(i);
      const text = this._srtText(e, bilingual);
      if (!win || !text) return;
      n += 1;
      lines.push(String(n));
      lines.push(`${srtTime(win[0])} --> ${srtTime(win[1])}`);
      lines.push(text);
      lines.push("");
    });
    return lines.join("\n");
  }

  _srtText(entry, bilingual) {
    const es = entry.spanish.trim();
    const jp = entry.japanese.trim();
    if (bilingual && jp && es) return `${jp}\n${es}`;
    return es || jp;
  }
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
