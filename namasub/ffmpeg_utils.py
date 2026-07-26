"""Localización y ayudantes de ffmpeg/ffprobe/ffplay.

La app depende de ffmpeg para: capturar la pantalla (gdigrab), extraer y
convertir audio, incrustar/quemar subtítulos y reproducir el resultado.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# En Windows, evita que cada subproceso abra una ventana de consola.
_CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


class FFmpegNotFound(RuntimeError):
    pass


def _candidates(name: str) -> list[Path]:
    exe = f"{name}.exe" if sys.platform == "win32" else name
    found = shutil.which(name)
    cands = [Path(found)] if found else []
    # bin/ junto al paquete (para distribuir ffmpeg con la app).
    cands.append(Path(__file__).resolve().parent.parent / "bin" / exe)
    # Rutas típicas de winget/chocolatey/scoop.
    local = os.environ.get("LOCALAPPDATA")
    if local:
        gnu = Path(local) / "Microsoft" / "WinGet" / "Links" / exe
        cands.append(gnu)
    home = Path.home()
    cands += [
        home / "scoop" / "shims" / exe,
        Path("C:/ProgramData/chocolatey/bin") / exe,
    ]
    return cands


def find_tool(name: str) -> str:
    for cand in _candidates(name):
        if cand and cand.exists():
            return str(cand)
    raise FFmpegNotFound(
        f"No se encontró `{name}`. Instala ffmpeg (por ejemplo: "
        "`winget install Gyan.FFmpeg`) o copia los .exe en la carpeta bin/ de la app."
    )


def ffmpeg_path() -> str:
    return find_tool("ffmpeg")


def ffprobe_path() -> str:
    return find_tool("ffprobe")


def ffplay_path() -> str:
    return find_tool("ffplay")


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    """Ejecuta un comando ffmpeg y devuelve el proceso completado.
    Lanza RuntimeError con el stderr si el comando falla."""
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=_CREATE_NO_WINDOW,
        **kwargs,
    )
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()[-8:]
        raise RuntimeError(
            f"ffmpeg falló ({proc.returncode}):\n" + "\n".join(tail)
        )
    return proc


def popen(cmd: list[str], **kwargs) -> subprocess.Popen:
    return subprocess.Popen(cmd, creationflags=_CREATE_NO_WINDOW, **kwargs)


def media_duration(path: str) -> float:
    """Duración del archivo en segundos, vía ffprobe."""
    proc = run([
        ffprobe_path(), "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        path,
    ])
    try:
        return float(proc.stdout.decode().strip())
    except ValueError:
        return 0.0


def list_dshow_audio_devices() -> list[str]:
    """Enumera los dispositivos de audio DirectShow (solo Windows).
    Útil para capturar con 'Stereo Mix', 'virtual-audio-capturer' o un micrófono."""
    if sys.platform != "win32":
        return []
    proc = subprocess.run(
        [ffmpeg_path(), "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=_CREATE_NO_WINDOW,
    )
    devices: list[str] = []
    in_audio = False
    for line in proc.stderr.decode("utf-8", "replace").splitlines():
        if "DirectShow audio devices" in line:
            in_audio = True
            continue
        if "DirectShow video devices" in line:
            in_audio = False
            continue
        if in_audio:
            match = re.search(r'"([^"]+)"', line)
            if match and "Alternative name" not in line:
                devices.append(match.group(1))
    return devices


def escape_filter_path(path: str) -> str:
    """Escapa una ruta para usarla dentro de un filtro de ffmpeg
    (p. ej. subtitles=...): en Windows los ':' y '\\' deben escaparse."""
    escaped = path.replace("\\", "/")
    escaped = escaped.replace(":", "\\:")
    escaped = escaped.replace("'", "\\'")
    return escaped
