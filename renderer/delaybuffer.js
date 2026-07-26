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

const MIME_CANDIDATES = [
  'video/webm;codecs="vp9,opus"',
  'video/webm;codecs="vp8,opus"',
  "video/webm",
];

function pickMime(hasAudio) {
  const candidates = hasAudio
    ? MIME_CANDIDATES
    : MIME_CANDIDATES.map((m) => m.replace(",opus", ""));
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime) && MediaSource.isTypeSupported(mime)) {
      return mime;
    }
  }
  throw new Error("Este sistema no soporta la codificación WebM necesaria.");
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
    const mime = pickMime(this.stream.getAudioTracks().length > 0);

    this._mediaSource = new MediaSource();
    this.video.src = URL.createObjectURL(this._mediaSource);
    await new Promise((resolve) =>
      this._mediaSource.addEventListener("sourceopen", resolve, { once: true })
    );
    this._sourceBuffer = this._mediaSource.addSourceBuffer(mime);
    this._sourceBuffer.mode = "sequence";
    this._sourceBuffer.addEventListener("updateend", () => this._flushQueue());

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
    } catch (err) {
      // QuotaExceeded: conserva el chunk, purga lo ya reproducido y reintenta.
      this._queue.unshift(chunk);
      this._evictPlayed();
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
    const lag = this.captureTimeMs() - this.mediaTimeMs();
    const target = this.delayMs;
    if (lag > target + 1500) {
      this.video.playbackRate = 1.05;
    } else if (lag < target - 500) {
      this.video.playbackRate = 0.95;
    } else {
      this.video.playbackRate = 1.0;
    }
    this._evictPlayed();
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
