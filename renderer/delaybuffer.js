// Reproducción diferida (time-shift): la clave para que los subtítulos vayan
// a la par del video.
//
// El stream capturado se codifica con MediaRecorder en trozos de 250 ms que se
// inyectan en un <video> mediante Media Source Extensions. La reproducción
// arranca recién cuando han pasado `delayMs` milisegundos, de modo que lo que
// se ve (y oye) va siempre N segundos detrás del vivo. Mientras tanto el audio
// en vivo ya viajó a transcripción+traducción, así que cuando un cuadro llega
// a pantalla sus subtítulos ya existen.
//
// El tiempo de media del <video> (currentTime) coincide con el reloj de
// captura: currentTime == 0 es el instante en que se pulsó Iniciar. Esa es la
// base de tiempo con la que se fechan los subtítulos.

// H.264 primero: en Windows se codifica por hardware (Media Foundation),
// mientras que VP9/VP8 van por software y ahogan la CPU con fuentes 4K.
const MIME_CANDIDATES = [
  'video/mp4;codecs="avc1.640028,opus"',
  'video/mp4;codecs="avc1.42E01E,opus"',
  'video/webm;codecs="vp9,opus"',
  'video/webm;codecs="vp8,opus"',
  "video/webm",
];

export function pickMime(hasAudio) {
  const candidates = hasAudio
    ? MIME_CANDIDATES
    : MIME_CANDIDATES.map((m) => m.replace(",opus", "").replace(";codecs=\"\"", ""));
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime) && MediaSource.isTypeSupported(mime)) {
      return mime;
    }
  }
  throw new Error("Este sistema no soporta la codificación de video necesaria.");
}

/** Extensión de archivo acorde al contenedor elegido. */
export function extensionForMime(mime) {
  return mime.includes("mp4") ? "mp4" : "webm";
}

export class DelayedPlayer {
  /**
   * @param {HTMLVideoElement} videoEl elemento donde se reproduce el diferido
   * @param {MediaStream} stream       stream capturado en vivo
   * @param {object} opts  {delayMs, onChunk(blobArrayBuffer), onState(txt)}
   */
  constructor(videoEl, stream, opts = {}) {
    this.video = videoEl;
    this.stream = stream;
    this.delayMs = opts.delayMs ?? 10000;
    this.mimeType = opts.mimeType || null; // null = elegir automáticamente
    this.onChunk = opts.onChunk || null;
    this.onState = opts.onState || (() => {});

    this._recorder = null;
    this._mediaSource = null;
    this._sourceBuffer = null;
    this._queue = [];
    this._startedAt = 0; // performance.now() al iniciar la captura
    this._playing = false;
    this._stopped = false;
    this._driftTimer = 0;
    this._appendRetries = 0;   // reintentos del chunk actual
    this._lastMediaMs = -1;    // watchdog de congelamiento
    this._stallTicks = 0;
  }

  /** Milisegundos transcurridos desde el inicio de la captura (reloj vivo). */
  captureTimeMs() {
    return this._startedAt ? performance.now() - this._startedAt : 0;
  }

  /** Posición actual del video diferido, en ms de reloj de captura. */
  mediaTimeMs() {
    return this.video.currentTime * 1000;
  }

  async start() {
    const mime =
      this.mimeType || pickMime(this.stream.getAudioTracks().length > 0);

    this._mediaSource = new MediaSource();
    this.video.src = URL.createObjectURL(this._mediaSource);
    await new Promise((resolve) =>
      this._mediaSource.addEventListener("sourceopen", resolve, { once: true })
    );
    this._sourceBuffer = this._mediaSource.addSourceBuffer(mime);
    this._sourceBuffer.mode = "sequence";
    this._sourceBuffer.addEventListener("updateend", () => this._flushQueue());
    this._sourceBuffer.addEventListener("error", () =>
      this.onState("error:sourcebuffer")
    );

    // Errores fatales del decodificador/elemento: repórtalos, no congeles.
    this.video.addEventListener("error", () => {
      const err = this.video.error;
      this.onState(`error:video:${err ? `${err.code} ${err.message || ""}` : "?"}`);
    });

    this._recorder = new MediaRecorder(this.stream, {
      mimeType: mime,
      videoBitsPerSecond: 6_000_000,
      audioBitsPerSecond: 160_000,
    });
    this._recorder.ondataavailable = async (event) => {
      if (!event.data || event.data.size === 0) return;
      const buf = await event.data.arrayBuffer();
      if (this._stopped) return;
      this._queue.push(buf);
      this._flushQueue();
      if (this.onChunk) this.onChunk(buf);
    };

    // Resampleo simple al variar playbackRate (±2% es inaudible en tono):
    // el time-stretching por defecto genera artefactos tipo clipping que
    // los DAC de TV por HDMI delatan especialmente.
    this.video.preservesPitch = false;

    this._recorder.start(250);
    this._startedAt = performance.now();
    this._armPlayback();
    this._driftTimer = setInterval(() => this._correctDrift(), 1000);
  }

  _flushQueue() {
    if (
      !this._sourceBuffer ||
      this._sourceBuffer.updating ||
      this._queue.length === 0 ||
      this._mediaSource.readyState !== "open"
    ) {
      return;
    }
    const chunk = this._queue.shift();
    try {
      this._sourceBuffer.appendBuffer(chunk);
      this._appendRetries = 0;
    } catch (err) {
      if (err && err.name === "QuotaExceededError") {
        // Buffer lleno: conserva el chunk, purga lo reproducido y reintenta.
        this._queue.unshift(chunk);
        this._evictPlayed();
        return;
      }
      // Error no recuperable en este chunk: reintenta un par de veces y si
      // persiste descártalo — un chunk perdido es un parpadeo; el reintento
      // infinito era un congelamiento permanente.
      this._appendRetries += 1;
      if (this._appendRetries <= 2) {
        this._queue.unshift(chunk);
      } else {
        this._appendRetries = 0;
        this.onState(`error:append:${err?.name || "?"} (chunk descartado)`);
      }
    }
  }

  _armPlayback() {
    const tick = () => {
      if (this._stopped || this._playing) return;
      const elapsed = this.captureTimeMs();
      const buffered = this.video.buffered;
      if (elapsed >= this.delayMs && buffered.length > 0) {
        this.video.currentTime = Math.max(0, buffered.start(0));
        this.video.play().catch(() => {});
        this._playing = true;
        this.onState("playing");
        return;
      }
      this.onState(`buffering:${Math.max(0, this.delayMs - elapsed)}`);
      setTimeout(tick, 200);
    };
    tick();
  }

  /**
   * Mantiene el atraso cerca de delayMs: si el diferido se queda más atrás
   * (pausas de red/encoder), acelera suavemente; si se acerca demasiado al
   * vivo, frena. Nunca salta cortes bruscos.
   */
  _correctDrift() {
    if (!this._playing || this._stopped) return;
    this._watchdog();
    const lag = this.captureTimeMs() - this.mediaTimeMs();
    const target = this.delayMs;
    // Corrección suave (±2%): cambios mayores de playbackRate producen
    // artefactos audibles en algunos receptores HDMI al resamplear.
    if (lag > target + 1500) {
      this.video.playbackRate = 1.02;
    } else if (lag < target - 500) {
      this.video.playbackRate = 0.98;
    } else {
      this.video.playbackRate = 1.0;
    }
    this._evictPlayed();
  }

  /** Detección y recuperación de congelamientos: si el video no avanza
   *  durante ~3 s mientras la captura sigue viva, salta hacia el borde del
   *  buffer y reanuda, en vez de quedarse pegado para siempre. */
  _watchdog() {
    const mediaMs = this.mediaTimeMs();
    if (mediaMs !== this._lastMediaMs) {
      this._lastMediaMs = mediaMs;
      this._stallTicks = 0;
      return;
    }
    this._stallTicks += 1;
    if (this._stallTicks < 3) return;
    this._stallTicks = 0;

    const buffered = this.video.buffered;
    if (buffered.length > 0) {
      const end = buffered.end(buffered.length - 1);
      const stuckAt = this.video.currentTime;
      if (end - stuckAt > 0.5) {
        // Hay datos por delante: salta el tramo dañado.
        this.video.currentTime = Math.max(stuckAt + 0.3, end - this.delayMs / 1000);
      }
    }
    this.video.play().catch(() => {});
    this.onState(`stall:recuperando @${(this.video.currentTime).toFixed(1)}s`);
  }

  _evictPlayed() {
    // Libera memoria: descarta lo reproducido hace más de 30 s.
    const sb = this._sourceBuffer;
    if (!sb || sb.updating) return;
    const cutoff = this.video.currentTime - 30;
    if (cutoff > 0 && this.video.buffered.length > 0) {
      const start = this.video.buffered.start(0);
      if (cutoff > start) {
        try {
          sb.remove(start, cutoff);
        } catch {
          /* se reintenta en el próximo tick */
        }
      }
    }
  }

  async stop() {
    this._stopped = true;
    clearInterval(this._driftTimer);
    if (this._recorder && this._recorder.state !== "inactive") {
      await new Promise((resolve) => {
        this._recorder.onstop = resolve;
        this._recorder.stop();
      });
    }
    try {
      if (this._mediaSource && this._mediaSource.readyState === "open") {
        this._mediaSource.endOfStream();
      }
    } catch {
      /* ya cerrado */
    }
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }
}
