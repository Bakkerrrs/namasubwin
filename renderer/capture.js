// Construcción del MediaStream a partir de la fuente elegida (estilo OBS):
// pantallas/ventanas vía desktopCapturer, cámaras/capturadoras vía getUserMedia,
// y audio del sistema por loopback WASAPI (Chromium lo soporta en Windows al
// capturar con chromeMediaSource: "desktop").

/** Lista cámaras y capturadoras de video (aparecen como videoinput). */
export async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "videoinput")
    .map((d) => ({ deviceId: d.deviceId, label: d.label || "Cámara" }));
}

/** Lista entradas de audio (micrófonos, line-in de capturadoras). */
export async function listAudioInputs() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audioinput")
    .map((d) => ({ deviceId: d.deviceId, label: d.label || "Entrada de audio" }));
}

/** Lista salidas de audio (parlantes, auriculares, HDMI…) para el reproductor.
 *  Elegir una salida distinta de la capturada evita que el audio diferido de
 *  la propia app vuelva a entrar por el loopback (bucle de eco). */
export async function listAudioOutputs() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audiooutput")
    .map((d) => ({ deviceId: d.deviceId, label: d.label || "Salida de audio" }));
}

/**
 * Pide permisos una vez para que enumerateDevices devuelva las etiquetas
 * reales de los dispositivos (Chromium las oculta hasta conceder permiso).
 */
export async function warmUpPermissions() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    /* sin cámara/micrófono no pasa nada: las fuentes de pantalla no lo requieren */
  }
}

/** Stream de pantalla/ventana; con systemAudio=true añade el loopback del
 *  sistema. `maxHeight` limita la resolución capturada (Chromium la escala
 *  conservando el aspecto): capturar un escritorio 4K a resolución nativa
 *  cuadruplica el costo de encoding sin aportar nada a los subtítulos. */
async function getDesktopStream(sourceId, withSystemAudio, maxHeight = 0) {
  const mandatory = {
    chromeMediaSource: "desktop",
    chromeMediaSourceId: sourceId,
    maxFrameRate: 30,
  };
  if (maxHeight > 0) {
    mandatory.maxHeight = maxHeight;
    mandatory.maxWidth = Math.round((maxHeight * 16) / 9);
  }
  const constraints = {
    audio: withSystemAudio
      ? { mandatory: { chromeMediaSource: "desktop" } }
      : false,
    video: { mandatory },
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

/**
 * Crea el stream combinado según la selección del usuario.
 *
 * @param {object} video  {kind: "screen"|"window", id} | {kind: "camera", deviceId}
 * @param {object} audio  {kind: "system"} | {kind: "device", deviceId} | {kind: "none"}
 * @param {object} opts   {desktopAudioId} id de pantalla para el loopback cuando
 *                        el video viene de una cámara (el loopback es global,
 *                        pero Chromium exige pedirlo junto a un video desktop);
 *                        {maxHeight} límite de resolución de captura (0 = nativa)
 * @returns {Promise<MediaStream>} stream con 1 pista de video y 0..1 de audio
 */
export async function buildStream(video, audio, opts = {}) {
  const out = new MediaStream();
  const owned = [];

  if (video.kind === "camera") {
    const cam = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: video.deviceId },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      },
    });
    out.addTrack(cam.getVideoTracks()[0]);

    if (audio.kind === "system") {
      // El loopback exige pedir también video de escritorio; se descarta esa pista.
      const desktop = await getDesktopStream(opts.desktopAudioId || "screen:0:0", true);
      desktop.getVideoTracks().forEach((t) => t.stop());
      const track = desktop.getAudioTracks()[0];
      if (track) out.addTrack(track);
    }
  } else {
    const desktop = await getDesktopStream(
      video.id,
      audio.kind === "system",
      opts.maxHeight || 0
    );
    out.addTrack(desktop.getVideoTracks()[0]);
    const track = desktop.getAudioTracks()[0];
    if (track) out.addTrack(track);
  }

  if (audio.kind === "device") {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: audio.deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    out.addTrack(mic.getAudioTracks()[0]);
  }

  // Cierra todo junto cuando el llamador detenga el stream combinado.
  out.getTracks().forEach((t) => owned.push(t));
  out.stopAll = () => owned.forEach((t) => t.stop());
  return out;
}

/**
 * Recorta la pista de video de `stream` (px por lado) redibujándola en un
 * canvas cuadro a cuadro. Sirve para quitar la barra de título al capturar
 * una ventana (Chromium siempre incluye el marco). El recorte queda dentro
 * del stream: afecta a lo que se ve, se graba y se sube de igual forma.
 *
 * @param {MediaStream} stream stream con video (y audio opcional)
 * @param {object} crop {top, bottom, left, right} en píxeles de la fuente
 * @returns {MediaStream} nuevo stream con el video recortado + el audio original
 */
export function cropStream(stream, crop) {
  const { top = 0, bottom = 0, left = 0, right = 0 } = crop;
  if (top + bottom + left + right === 0) return stream;

  const source = document.createElement("video");
  source.srcObject = new MediaStream(stream.getVideoTracks());
  source.muted = true;
  source.play().catch(() => {});

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  let stopped = false;

  // Las dimensiones del canvas se fijan con el PRIMER cuadro y no cambian:
  // un cambio de resolución a mitad de stream (ventana redimensionada)
  // puede matar el decoder MSE y congelar la reproducción. Si la fuente
  // cambia de tamaño, se escala al lienzo original.
  const draw = () => {
    if (stopped) return;
    if (source.videoWidth > 0) {
      if (canvas.width <= 2) {
        // Dimensiones pares: los encoders de video lo exigen.
        canvas.width = Math.max(2, (source.videoWidth - left - right) & ~1);
        canvas.height = Math.max(2, (source.videoHeight - top - bottom) & ~1);
      }
      const sw = Math.max(2, source.videoWidth - left - right);
      const sh = Math.max(2, source.videoHeight - top - bottom);
      ctx.drawImage(source, left, top, sw, sh, 0, 0, canvas.width, canvas.height);
    }
    source.requestVideoFrameCallback(draw);
  };
  canvas.width = 2;
  canvas.height = 2;
  source.requestVideoFrameCallback(draw);

  const out = canvas.captureStream();
  stream.getAudioTracks().forEach((t) => out.addTrack(t));

  const original = stream;
  out.stopAll = () => {
    stopped = true;
    out.getVideoTracks().forEach((t) => t.stop());
    source.srcObject = null;
    original.stopAll?.();
  };
  return out;
}
