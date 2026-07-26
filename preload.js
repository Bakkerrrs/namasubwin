// Puente seguro entre el renderer y el proceso principal.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("namasub", {
  listSources: () => ipcRenderer.invoke("sources:list"),

  getApiKey: () => ipcRenderer.invoke("apikey:get"),
  setApiKey: (key) => ipcRenderer.invoke("apikey:set", key),

  startRecordingFile: () => ipcRenderer.invoke("rec:start"),
  appendRecordingChunk: (buffer) => ipcRenderer.send("rec:chunk", buffer),
  stopRecordingFile: () => ipcRenderer.invoke("rec:stop"),

  saveSrt: (text, suggestedName) =>
    ipcRenderer.invoke("srt:save", { text, suggestedName }),

  onFullscreen: (callback) =>
    ipcRenderer.on("fullscreen", (event, isFull) => callback(isFull)),
});
