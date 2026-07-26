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

/** Stream de pantalla/ventana; con systemAudio=true añade el loopback del sistema. */
async function getDesktopStream(sourceId, withSystemAudio) {
  const constraints = {
    audio: withSystemAudio
      ? { mandatory: { chromeMediaSource: "desktop" } }
      : false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        maxFrameRate: 30,
      },
    },
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
 *                        pero Chromium exige pedirlo junto a un video desktop)
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
    const desktop = await getDesktopStream(video.id, audio.kind === "system");
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
