"""Tipos de datos compartidos (puerto de Models.swift de la app iOS)."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class SubtitleSegment:
    """Un bloque de subtítulo: japonés transcrito + traducción al español,
    con su ventana de tiempo dentro del video capturado (en segundos)."""

    start: float
    end: float
    japanese: str = ""
    spanish: str = ""

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


# Modelos de OpenAI para la traducción de texto. Misma lista que la app iOS
# (cameraModels): los `gpt-5.x` usan razonamiento y se les manda
# `reasoning_effort: "none"` para baja latencia; los demás no lo aceptan.
TRANSLATE_MODELS = [
    "gpt-5.6-luna",   # más rápido (recomendado)
    "gpt-5.6-terra",  # equilibrado
    "gpt-5.6-sol",    # máxima calidad (más lento)
    "gpt-4.1-mini",
    "gpt-4o-mini",
]

DEFAULT_TRANSLATE_MODEL = TRANSLATE_MODELS[0]

# Modelo de transcripción (Whisper API con timestamps por segmento).
TRANSCRIBE_MODEL = "whisper-1"

# Idiomas por defecto: japonés → español, igual que la app iOS.
DEFAULT_SOURCE_LANG = "ja"
DEFAULT_TARGET_LANG = "es"


@dataclass
class CaptureSettings:
    """Parámetros de la captura de pantalla + audio del sistema."""

    fps: int = 30
    # Región de pantalla (x, y, ancho, alto); None = pantalla completa.
    region: tuple[int, int, int, int] | None = None
    # Título de ventana a capturar; tiene prioridad sobre `region`.
    window_title: str | None = None
    # "loopback" (audio del sistema, WASAPI), "dshow:<nombre>" (dispositivo
    # DirectShow, p. ej. Stereo Mix o un micrófono) o "none" (sin audio).
    audio: str = "loopback"
    # Ajuste manual de sincronía A/V en milisegundos (positivo atrasa el audio).
    sync_offset_ms: int = 0


@dataclass
class SubtitleStyle:
    """Estilo de los subtítulos generados (para ASS y quemado)."""

    font: str = "Arial"
    font_size: int = 28
    # Mostrar también la línea japonesa encima de la traducción.
    bilingual: bool = False
    # Caracteres máximos por línea antes de partir en dos.
    max_line_chars: int = 46


@dataclass
class PipelineResult:
    """Rutas de salida del pipeline completo."""

    video: str = ""            # MP4 final con la pista de subtítulos embebida
    srt: str = ""              # subtítulos en SRT (sidecar)
    ass: str = ""              # subtítulos en ASS con estilo (para reproducir/quemar)
    burned_video: str = ""     # MP4 con subtítulos quemados (solo si se pidió)
    segments: list[SubtitleSegment] = field(default_factory=list)
