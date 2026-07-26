"""Configuración persistente y manejo de la API Key.

Prioridad de la API Key (igual que la app iOS: variable de entorno primero,
almacén local después):
  1. Variable de entorno ``OPENAI_API_KEY``.
  2. Credential Manager de Windows vía ``keyring`` (si está instalado).
  3. Archivo de configuración en ``%APPDATA%/NamaSub/config.json``.

El resto de los ajustes (modelo, estilo, captura) viven en el mismo JSON.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

APP_NAME = "NamaSub"
_KEYRING_SERVICE = "NamaSub-OpenAI"
_KEYRING_USER = "api_key"


def config_dir() -> Path:
    """Carpeta de configuración: %APPDATA%/NamaSub en Windows, ~/.config/namasub
    en otros sistemas (útil para desarrollo)."""
    appdata = os.environ.get("APPDATA")
    base = Path(appdata) if appdata else Path.home() / ".config"
    path = base / APP_NAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def _config_file() -> Path:
    return config_dir() / "config.json"


def load_config() -> dict:
    try:
        return json.loads(_config_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_config(cfg: dict) -> None:
    _config_file().write_text(
        json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# API Key
# ---------------------------------------------------------------------------

def load_api_key() -> str:
    env = os.environ.get("OPENAI_API_KEY", "").strip()
    if env:
        return env

    try:
        import keyring  # opcional

        saved = keyring.get_password(_KEYRING_SERVICE, _KEYRING_USER)
        if saved:
            return saved.strip()
    except Exception:
        pass

    return str(load_config().get("api_key", "")).strip()


def save_api_key(key: str) -> None:
    """Guarda la key en el Credential Manager si hay keyring; si no, en el
    JSON de configuración (con permisos del usuario)."""
    key = key.strip()
    try:
        import keyring

        if key:
            keyring.set_password(_KEYRING_SERVICE, _KEYRING_USER, key)
        else:
            try:
                keyring.delete_password(_KEYRING_SERVICE, _KEYRING_USER)
            except Exception:
                pass
        # Si quedó una copia vieja en el JSON, elimínala.
        cfg = load_config()
        if "api_key" in cfg:
            cfg.pop("api_key")
            save_config(cfg)
        return
    except ImportError:
        pass

    cfg = load_config()
    if key:
        cfg["api_key"] = key
    else:
        cfg.pop("api_key", None)
    save_config(cfg)


def output_dir() -> Path:
    """Carpeta de salida por defecto para capturas y videos subtitulados:
    ~/Videos/NamaSub (se crea si no existe)."""
    cfg = load_config()
    custom = cfg.get("output_dir")
    base = Path(custom) if custom else Path.home() / "Videos" / APP_NAME
    base.mkdir(parents=True, exist_ok=True)
    return base
