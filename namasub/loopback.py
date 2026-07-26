"""Grabación del audio del sistema por WASAPI loopback (solo Windows).

Esto es lo que iOS no permite y Windows sí: capturar lo que suena por los
parlantes (la TV en streaming, un video, una llamada) sin cables virtuales
ni "Stereo Mix". Usa `pyaudiowpatch`, un fork de PyAudio con soporte de
dispositivos loopback WASAPI.
"""

from __future__ import annotations

import threading
import time
import wave


class LoopbackUnavailable(RuntimeError):
    pass


def _load_pyaudio():
    try:
        import pyaudiowpatch as pyaudio  # type: ignore

        return pyaudio
    except ImportError as exc:
        raise LoopbackUnavailable(
            "Falta `pyaudiowpatch` (pip install pyaudiowpatch). "
            "Como alternativa usa `--audio dshow:<dispositivo>`."
        ) from exc


class LoopbackRecorder:
    """Graba el dispositivo de salida por defecto (loopback) a un WAV.

    Uso:
        rec = LoopbackRecorder("audio.wav")
        rec.start()   # devuelve el timestamp (time.monotonic) del arranque
        ...
        rec.stop()
    """

    def __init__(self, wav_path: str):
        self.wav_path = wav_path
        self.started_at: float | None = None
        self._pa = None
        self._stream = None
        self._wav = None
        self._lock = threading.Lock()

    def _default_loopback_device(self, pa_module, pa):
        """Dispositivo loopback correspondiente a la salida por defecto."""
        try:
            wasapi = pa.get_host_api_info_by_type(pa_module.paWASAPI)
        except OSError as exc:
            raise LoopbackUnavailable("WASAPI no disponible en este sistema.") from exc

        speakers = pa.get_device_info_by_index(wasapi["defaultOutputDevice"])
        if speakers.get("isLoopbackDevice"):
            return speakers
        for loopback in pa.get_loopback_device_info_generator():
            if speakers["name"] in loopback["name"]:
                return loopback
        raise LoopbackUnavailable(
            "No se encontró un dispositivo loopback para la salida por defecto."
        )

    def start(self) -> float:
        pa_module = _load_pyaudio()
        self._pa = pa_module.PyAudio()
        device = self._default_loopback_device(pa_module, self._pa)

        channels = int(device["maxInputChannels"])
        rate = int(device["defaultSampleRate"])

        self._wav = wave.open(self.wav_path, "wb")
        self._wav.setnchannels(channels)
        self._wav.setsampwidth(2)  # PCM16, igual que la app iOS
        self._wav.setframerate(rate)

        def callback(in_data, frame_count, time_info, status):
            with self._lock:
                if self._wav is not None:
                    self._wav.writeframes(in_data)
            return (in_data, pa_module.paContinue)

        self._stream = self._pa.open(
            format=pa_module.paInt16,
            channels=channels,
            rate=rate,
            frames_per_buffer=1024,
            input=True,
            input_device_index=device["index"],
            stream_callback=callback,
        )
        self.started_at = time.monotonic()
        return self.started_at

    def stop(self) -> str:
        if self._stream is not None:
            self._stream.stop_stream()
            self._stream.close()
            self._stream = None
        if self._pa is not None:
            self._pa.terminate()
            self._pa = None
        with self._lock:
            if self._wav is not None:
                self._wav.close()
                self._wav = None
        return self.wav_path
