// VAD local por energía (RMS): fecha los turnos de habla contra el reloj de
// captura cuando el motor no entrega eventos de VAD del servidor.
//
// gpt-live-transcribe segmenta el audio internamente (no acepta
// turn_detection), así que los timestamps de los subtítulos salen de aquí:
// cada bloque de audio que va a la API ya pasa por el cálculo de RMS del
// medidor de debug; este detector lo convierte en speechStarted/speechStopped.
//
// Módulo puro (sin DOM) para poder probarlo con node --test.

export class LocalVad {
  /**
   * @param {object} opts
   *   threshold  RMS mínimo para considerar voz (0..1, típico 0.02-0.05)
   *   prefixMs   cuánto retroceder el inicio detectado (ataques suaves)
   *   silenceMs  silencio continuo que cierra el turno
   *   maxTurnMs  duración máxima de un turno: el habla continua sin pausas
   *              se parte a la fuerza (misma idea que translateMaxSeconds
   *              en la app iOS) para acotar la latencia del subtítulo
   */
  constructor(opts = {}) {
    this.configure(opts);
    this.speaking = false;
    this._lastVoiceMs = null;
    this._turnStartMs = null;
  }

  configure({ threshold, prefixMs, silenceMs, maxTurnMs } = {}) {
    if (threshold != null) this.threshold = threshold;
    if (prefixMs != null) this.prefixMs = prefixMs;
    if (silenceMs != null) this.silenceMs = silenceMs;
    if (maxTurnMs != null) this.maxTurnMs = maxTurnMs;
    this.threshold ??= 0.03;
    this.prefixMs ??= 200;
    this.silenceMs ??= 350;
    this.maxTurnMs ??= 7000;
  }

  reset() {
    this.speaking = false;
    this._lastVoiceMs = null;
    this._turnStartMs = null;
  }

  /**
   * Procesa el nivel de un bloque de audio.
   * @param {number} rms   nivel RMS del bloque (0..1)
   * @param {number} nowMs instante del bloque en el reloj de captura
   * @returns {{type: "start"|"stop", ms: number} | null}
   */
  update(rms, nowMs) {
    const voiced = rms >= this.threshold;

    if (voiced) {
      this._lastVoiceMs = nowMs;
      if (!this.speaking) {
        this.speaking = true;
        this._turnStartMs = Math.max(0, nowMs - this.prefixMs);
        return { type: "start", ms: this._turnStartMs };
      }
      // Habla continua sin pausas: corta el turno al llegar al máximo (el
      // siguiente bloque con voz abrirá uno nuevo de inmediato).
      if (this._turnStartMs != null && nowMs - this._turnStartMs >= this.maxTurnMs) {
        this.speaking = false;
        return { type: "stop", ms: nowMs, forced: true };
      }
      return null;
    }

    if (this.speaking && this._lastVoiceMs != null && nowMs - this._lastVoiceMs >= this.silenceMs) {
      this.speaking = false;
      return { type: "stop", ms: this._lastVoiceMs };
    }
    return null;
  }
}
