"""NamaSub para Windows — captura video/audio, translitera el audio japonés y
lo convierte en subtítulos en español dentro del video capturado.

Hermana de la app iOS (TransliterateJPES): comparte los mismos prompts de
traducción, el mismo manejo de contexto y la misma filosofía de pipeline
rec → STT → traducción, pero aprovecha lo que iOS no permite: en Windows sí
se puede capturar el audio del sistema (WASAPI loopback) y la pantalla.
"""

__version__ = "0.1.0"
