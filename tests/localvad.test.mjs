// Pruebas del VAD local por energía.

import { test } from "node:test";
import assert from "node:assert/strict";

import { LocalVad } from "../renderer/localvad.js";

test("detecta inicio de voz con retroceso de prefijo", () => {
  const vad = new LocalVad({ threshold: 0.03, prefixMs: 200, silenceMs: 350 });
  assert.equal(vad.update(0.01, 1000), null);
  const start = vad.update(0.08, 1100);
  assert.deepEqual(start, { type: "start", ms: 900 });
  // Mientras siga la voz no re-emite.
  assert.equal(vad.update(0.09, 1200), null);
});

test("cierra el turno tras el silencio configurado", () => {
  const vad = new LocalVad({ threshold: 0.03, prefixMs: 0, silenceMs: 350 });
  vad.update(0.08, 1000); // start
  assert.equal(vad.update(0.01, 1200), null);  // silencio corto: aún no
  const stop = vad.update(0.01, 1400);
  assert.deepEqual(stop, { type: "stop", ms: 1000 }); // fin = última voz
  // Ya cerrado: el silencio no re-emite.
  assert.equal(vad.update(0.01, 2000), null);
});

test("micro-pausas dentro del turno no lo cortan", () => {
  const vad = new LocalVad({ threshold: 0.03, prefixMs: 0, silenceMs: 350 });
  vad.update(0.08, 1000);
  vad.update(0.01, 1150);           // pausa de 150 ms
  assert.equal(vad.update(0.07, 1300), null); // vuelve la voz: mismo turno
  const stop = vad.update(0.0, 1700);
  assert.equal(stop.type, "stop");
  assert.equal(stop.ms, 1300);
});

test("el habla continua se parte a la fuerza al llegar al máximo", () => {
  const vad = new LocalVad({ threshold: 0.03, prefixMs: 0, silenceMs: 350, maxTurnMs: 7000 });
  vad.update(0.08, 1000); // start
  assert.equal(vad.update(0.08, 5000), null);       // dentro del máximo
  const cut = vad.update(0.08, 8100);               // 7.1 s de habla continua
  assert.equal(cut.type, "stop");
  assert.ok(cut.forced);
  // El siguiente bloque con voz abre un turno nuevo de inmediato.
  const next = vad.update(0.08, 8200);
  assert.equal(next.type, "start");
});

test("el inicio nunca es negativo y configure ajusta en caliente", () => {
  const vad = new LocalVad({ threshold: 0.03, prefixMs: 500, silenceMs: 350 });
  const start = vad.update(0.1, 100);
  assert.equal(start.ms, 0);
  vad.configure({ threshold: 0.2 });
  vad.reset();
  assert.equal(vad.update(0.1, 1000), null); // bajo el nuevo umbral
});
