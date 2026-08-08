// Proceso principal de Electron: ventana, fullscreen con Alt+Enter, listado de
// fuentes de captura (estilo OBS), API key cifrada y guardado de grabaciones.
"use strict";

const {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  safeStorage,
  session,
} = require("electron");
const fs = require("fs");
const path = require("path");

// Pantallas HDR: la captura de un escritorio compuesto en HDR llega sin mapeo
// de tonos y se ve lavada. Estos switches mitigan: perfil de color sRGB para
// todo el pipeline y el capturador WGC (maneja mejor las superficies HDR que
// la duplicación DXGI clásica). El resto de la corrección es ajustable en la UI.
app.commandLine.appendSwitch("force-color-profile", "srgb");
app.commandLine.appendSwitch(
  "enable-features",
  "WebRtcAllowWgcDesktopCapturer,WebRtcAllowWgcScreenCapturer,WebRtcAllowWgcWindowCapturer"
);

let win = null;

// ---------------------------------------------------------------------------
// Ventana
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0f1115",
    title: "NamaSub",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // La detección de oclusión de Chromium tiene falsos positivos con
      // ventanas fullscreen en Windows: pausaba el requestAnimationFrame
      // que dibuja los subtítulos (video andando, subs congelados).
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Alt+Enter o F11 alternan pantalla completa, como los reproductores clásicos.
  // F12 abre las DevTools (útil junto al modo debug de la app).
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const altEnter = input.alt && input.key === "Enter";
    if (altEnter || input.key === "F11") {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    } else if (input.key === "F12") {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  win.on("enter-full-screen", () => win.webContents.send("fullscreen", true));
  win.on("leave-full-screen", () => win.webContents.send("fullscreen", false));
}

app.whenReady().then(() => {
  // Permite getUserMedia con chromeMediaSource (captura de pantalla + loopback).
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(["media", "display-capture"].includes(permission));
  });
  createWindow();
});

app.on("window-all-closed", () => app.quit());

// ---------------------------------------------------------------------------
// Fuentes de captura (pantallas y ventanas, con miniatura — como OBS)
// ---------------------------------------------------------------------------

ipcMain.handle("sources:list", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith("screen") ? "screen" : "window",
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

// ---------------------------------------------------------------------------
// API Key (cifrada con DPAPI vía safeStorage; prioridad: variable de entorno)
// ---------------------------------------------------------------------------

const keyFile = () => path.join(app.getPath("userData"), "apikey.bin");

ipcMain.handle("apikey:get", () => {
  const env = (process.env.OPENAI_API_KEY || "").trim();
  if (env) return { key: env, fromEnv: true };
  try {
    const blob = fs.readFileSync(keyFile());
    if (safeStorage.isEncryptionAvailable()) {
      return { key: safeStorage.decryptString(blob), fromEnv: false };
    }
  } catch {
    /* sin key guardada */
  }
  return { key: "", fromEnv: false };
});

ipcMain.handle("apikey:set", (event, key) => {
  const clean = String(key || "").trim();
  if (!clean) {
    fs.rmSync(keyFile(), { force: true });
    return true;
  }
  if (!safeStorage.isEncryptionAvailable()) return false;
  fs.writeFileSync(keyFile(), safeStorage.encryptString(clean));
  return true;
});

// ---------------------------------------------------------------------------
// Guardado de la sesión: video (webm) y subtítulos (SRT)
// ---------------------------------------------------------------------------

let recStream = null;

ipcMain.handle("rec:start", async (event, ext) => {
  const extension = ext === "mp4" ? "mp4" : "webm";
  const stamp = new Date()
    .toISOString()
    .replace(/[:T]/g, "-")
    .slice(0, 19);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Guardar grabación",
    defaultPath: path.join(app.getPath("videos"), `namasub-${stamp}.${extension}`),
    filters: [{ name: `Video ${extension.toUpperCase()}`, extensions: [extension] }],
  });
  if (canceled || !filePath) return null;
  recStream = fs.createWriteStream(filePath);
  return filePath;
});

// Estado de la aceleración por GPU (para verificarla desde el modo debug).
ipcMain.handle("gpu:status", () => app.getGPUFeatureStatus());

// Con una sesión activa, evita que Windows apague la pantalla a mitad del
// programa (el espectador no toca el mouse por largos ratos).
const { powerSaveBlocker } = require("electron");
let sleepBlockerId = null;

ipcMain.on("session:active", (event, active) => {
  if (active && sleepBlockerId == null) {
    sleepBlockerId = powerSaveBlocker.start("prevent-display-sleep");
  } else if (!active && sleepBlockerId != null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
});

ipcMain.on("rec:chunk", (event, buffer) => {
  if (recStream) recStream.write(Buffer.from(buffer));
});

ipcMain.handle("rec:stop", async () => {
  if (!recStream) return;
  await new Promise((resolve) => recStream.end(resolve));
  recStream = null;
});

// Copiado desde el proceso principal: navigator.clipboard del renderer queda
// bloqueado por el handler de permisos de la ventana.
ipcMain.handle("clipboard:write", (event, text) => {
  clipboard.writeText(String(text ?? ""));
  return true;
});

ipcMain.handle("log:save", async (event, text) => {
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Guardar registro de depuración",
    defaultPath: path.join(app.getPath("documents"), `namasub-debug-${stamp}.txt`),
    filters: [{ name: "Texto", extensions: ["txt"] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, String(text ?? ""), "utf-8");
  return filePath;
});

ipcMain.handle("srt:save", async (event, { text, suggestedName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Exportar subtítulos",
    defaultPath: path.join(app.getPath("videos"), suggestedName || "namasub.srt"),
    filters: [{ name: "Subtítulos SRT", extensions: ["srt"] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, text, "utf-8");
  return filePath;
});
