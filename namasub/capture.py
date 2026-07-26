"""Captura de pantalla + audio del sistema en Windows.

Video: ffmpeg con `gdigrab` (pantalla completa, región o ventana por título).
Audio: dos vías, elegibles con CaptureSettings.audio:
  - "loopback"        → WASAPI loopback (audio del sistema) con pyaudiowpatch,
                        grabado en paralelo y muxeado al detener. Es el modo
                        por defecto: no requiere configurar nada en Windows.
  - "dshow:<nombre>"  → un solo proceso ffmpeg con el dispositivo DirectShow
                        indicado (Stereo Mix, virtual-audio-capturer, micrófono).
                        Sincronía perfecta, pero requiere que el dispositivo exista.
  - "none"            → solo video.
"""

from __future__ import annotations

import time
from pathlib import Path

from .ffmpeg_utils import ffmpeg_path, popen, run
from .loopback import LoopbackRecorder
from .models import CaptureSettings


class ScreenRecorder:
    """Controla una sesión de grabación: start() → stop() → archivo MP4."""

    def __init__(self, output: str, settings: CaptureSettings | None = None):
        self.output = str(output)
        self.settings = settings or CaptureSettings()
        self._ffmpeg = None
        self._loopback: LoopbackRecorder | None = None
        self._video_tmp = ""
        self._audio_tmp = ""
        self._video_started_at: float | None = None

    # ------------------------------------------------------------------
    # Construcción del comando de video
    # ------------------------------------------------------------------

    def _video_input_args(self) -> list[str]:
        s = self.settings
        args = ["-f", "gdigrab", "-framerate", str(s.fps)]
        if s.window_title:
            target = f"title={s.window_title}"
        else:
            target = "desktop"
            if s.region:
                x, y, w, h = s.region
                args += [
                    "-offset_x", str(x), "-offset_y", str(y),
                    "-video_size", f"{w}x{h}",
                ]
        args += ["-i", target]
        return args

    def _encode_args(self) -> list[str]:
        # yuv420p y dimensiones pares: compatibilidad con cualquier reproductor.
        return [
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-vf", "crop=floor(iw/2)*2:floor(ih/2)*2",
        ]

    def build_command(self) -> list[str]:
        """Comando ffmpeg completo (expuesto para pruebas)."""
        s = self.settings
        cmd = [ffmpeg_path(), "-hide_banner", "-y"]
        cmd += self._video_input_args()

        if s.audio.startswith("dshow:"):
            device = s.audio.split(":", 1)[1]
            cmd += ["-f", "dshow", "-i", f"audio={device}"]
            cmd += self._encode_args()
            cmd += ["-c:a", "aac", "-b:a", "160k"]
        else:
            cmd += self._encode_args()
            cmd += ["-an"]

        cmd += [self._video_tmp if s.audio == "loopback" else self.output]
        return cmd

    # ------------------------------------------------------------------
    # Control
    # ------------------------------------------------------------------

    def start(self) -> None:
        s = self.settings
        out = Path(self.output)
        out.parent.mkdir(parents=True, exist_ok=True)

        if s.audio == "loopback":
            self._video_tmp = str(out.with_suffix(".video.mp4"))
            self._audio_tmp = str(out.with_suffix(".audio.wav"))
            self._loopback = LoopbackRecorder(self._audio_tmp)

        cmd = self.build_command()

        # Arranca el audio primero (su latencia de inicio es mínima) y toma
        # timestamps de ambos para compensar el arranque de ffmpeg al muxear.
        audio_started_at = self._loopback.start() if self._loopback else None

        import subprocess

        self._ffmpeg = popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        self._video_started_at = time.monotonic()
        self._audio_started_at = audio_started_at

        # Si ffmpeg muere de inmediato (dispositivo inexistente, permiso),
        # repórtalo ahora y no al detener.
        time.sleep(0.6)
        if self._ffmpeg.poll() is not None:
            stderr = self._ffmpeg.stderr.read().decode("utf-8", "replace")
            if self._loopback:
                self._loopback.stop()
            raise RuntimeError(
                "ffmpeg no pudo iniciar la captura:\n"
                + "\n".join(stderr.strip().splitlines()[-8:])
            )

    def stop(self) -> str:
        """Detiene la grabación y devuelve la ruta del MP4 final."""
        if self._ffmpeg is not None:
            try:
                self._ffmpeg.stdin.write(b"q")  # cierre limpio de ffmpeg
                self._ffmpeg.stdin.flush()
            except (BrokenPipeError, OSError, ValueError):
                pass
            try:
                self._ffmpeg.wait(timeout=15)
            except Exception:
                self._ffmpeg.kill()
                self._ffmpeg.wait()
            self._ffmpeg = None

        if self._loopback is not None:
            self._loopback.stop()
            self._mux_loopback()
            self._loopback = None

        return self.output

    # ------------------------------------------------------------------
    # Mux video + audio loopback
    # ------------------------------------------------------------------

    def _mux_loopback(self) -> None:
        """Combina el video (ffmpeg) con el WAV loopback compensando la
        diferencia de arranque entre ambos procesos."""
        # El audio arrancó antes que el primer frame de video: recorta esa
        # diferencia del WAV para alinear, más el ajuste manual del usuario.
        delta = 0.0
        if self._audio_started_at is not None and self._video_started_at is not None:
            delta = self._video_started_at - self._audio_started_at
        delta += self.settings.sync_offset_ms / 1000.0

        cmd = [ffmpeg_path(), "-hide_banner", "-y", "-i", self._video_tmp]
        if delta > 0:
            cmd += ["-ss", f"{delta:.3f}"]
        elif delta < 0:
            cmd += ["-itsoffset", f"{-delta:.3f}"]
        cmd += [
            "-i", self._audio_tmp,
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
            "-shortest",
            self.output,
        ]
        run(cmd)

        for tmp in (self._video_tmp, self._audio_tmp):
            try:
                Path(tmp).unlink(missing_ok=True)
            except OSError:
                pass
