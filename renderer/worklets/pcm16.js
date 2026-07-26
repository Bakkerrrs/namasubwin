// AudioWorklet: convierte el audio capturado a PCM16 mono y lo entrega en
// bloques de ~100 ms. El AudioContext ya corre a 24 kHz (lo fija app.js), el
// formato que exige la Realtime API — igual que AudioCapture.swift en iOS.

class Pcm16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(2400); // 100 ms a 24 kHz
    this._filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Mezcla a mono promediando canales.
    const channels = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let sample = 0;
      for (let c = 0; c < channels; c++) sample += input[c][i];
      sample /= channels;
      const clamped = Math.max(-1, Math.min(1, sample));
      this._buffer[this._filled++] =
        clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

      if (this._filled === this._buffer.length) {
        this.port.postMessage(this._buffer.buffer.slice(0));
        this._filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm16", Pcm16Processor);
