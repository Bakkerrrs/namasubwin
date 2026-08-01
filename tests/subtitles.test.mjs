// Pruebas de la línea de tiempo de subtítulos (lógica pura, sin DOM).
// Ejecutar con: npm test  (node --test tests/)

import { test } from "node:test";
import assert from "node:assert/strict";

import { SubtitleTimeline, srtTime, splitText } from "../renderer/subtitles.js";

function makeTurn(t, { start, end, jp, es }) {
  t.speechStarted(start);
  t.speechStopped(end);
  t.inputTranscript(jp);
  t.responseStarted();
  for (const token of es.split(" ")) t.outputTextDelta(token + " ");
  t.responseCompleted();
}

test("un turno completo queda emparejado con su ventana de tiempo", () => {
  const t = new SubtitleTimeline();
  makeTurn(t, { start: 1000, end: 3000, jp: "こんにちは", es: "Hola" });

  assert.equal(t.entries.length, 1);
  const e = t.entries[0];
  assert.equal(e.japanese, "こんにちは");
  assert.equal(e.spanish.trim(), "Hola");
  assert.equal(e.startMs, 1000);
  assert.equal(e.endMs, 3000);
  assert.ok(e.done);
});

test("activeAt muestra el subtítulo dentro de su ventana y no fuera", () => {
  const t = new SubtitleTimeline();
  makeTurn(t, { start: 1000, end: 3000, jp: "テスト", es: "Prueba" });

  assert.equal(t.activeAt(500), null);
  assert.equal(t.activeAt(1500)?.spanish.trim(), "Prueba");
  // Cola de 1200 ms tras el fin del habla
  assert.equal(t.activeAt(4100)?.spanish.trim(), "Prueba");
  assert.equal(t.activeAt(4300), null);
});

test("una duración mínima evita subtítulos relámpago", () => {
  const t = new SubtitleTimeline();
  makeTurn(t, { start: 1000, end: 1100, jp: "え?", es: "¿Eh?" });
  // 1100 + 1200 de cola < 1000 + 1800 mínimo → se extiende al mínimo
  assert.ok(t.activeAt(2700));
  assert.equal(t.activeAt(2900), null);
});

test("dos turnos seguidos no se pisan", () => {
  const t = new SubtitleTimeline();
  makeTurn(t, { start: 1000, end: 4000, jp: "一", es: "Uno" });
  makeTurn(t, { start: 4500, end: 7000, jp: "二", es: "Dos" });

  assert.equal(t.activeAt(4200)?.spanish.trim(), "Uno");
  assert.equal(t.activeAt(4600)?.spanish.trim(), "Dos");
});

test("los tokens de traducción van al turno más antiguo sin traducir", () => {
  const t = new SubtitleTimeline();
  // Dos turnos hablados antes de que llegue traducción alguna (backlog)
  t.speechStarted(1000);
  t.speechStopped(2000);
  t.inputTranscript("一番");
  t.speechStarted(2500);
  t.speechStopped(3500);
  t.inputTranscript("二番");

  t.responseStarted();
  t.outputTextDelta("Primero");
  t.responseCompleted();
  t.responseStarted();
  t.outputTextDelta("Segundo");
  t.responseCompleted();

  assert.equal(t.entries[0].spanish, "Primero");
  assert.equal(t.entries[1].spanish, "Segundo");
});

test("las transcripciones en backlog van al turno más antiguo sin texto", () => {
  const t = new SubtitleTimeline();
  // Dos turnos hablados cuyo texto llega después (backlog de la API)
  t.speechStarted(1000);
  t.speechStopped(2000);
  t.speechStarted(2500);
  t.speechStopped(3500);

  t.inputTranscript("一番");
  t.inputTranscript("二番");

  assert.equal(t.entries[0].japanese, "一番");
  assert.equal(t.entries[1].japanese, "二番");
});

test("una transcripción sin turno libre se fecha tras el último tiempo conocido", () => {
  const t = new SubtitleTimeline();
  makeTurn(t, { start: 1000, end: 4000, jp: "一", es: "Uno" });
  // Llega otra transcripción sin speech_started que la respalde.
  const entry = t.inputTranscript("迷子の字幕");
  assert.equal(entry.startMs, 4000);
  assert.equal(entry.endMs, 6000);
  // Es visible (no queda huérfana sin ventana); sin traducción aún, el
  // japonés ocupa la línea principal.
  assert.equal(t.activeAt(4500)?.spanish, "迷子の字幕");
});

test("un turno de ruido sin transcripción no secuestra traducciones futuras", () => {
  const t = new SubtitleTimeline();
  // Turno fantasma: VAD abre y cierra, pero nunca llega transcripción.
  t.speechStarted(1000);
  t.speechStopped(1500);

  // Turno real posterior: al abrir, el fantasma debe quedar descartado.
  t.speechStarted(60000);
  t.speechStopped(63000);
  t.inputTranscript("本物");
  t.responseStarted();
  t.outputTextDelta("Real");
  t.responseCompleted();

  // La traducción aterrizó en el turno real (ventana vigente), no en el ruido.
  assert.equal(t.entries[0].spanish, "");
  assert.ok(t.entries[0].done);
  assert.equal(t.entries[1].spanish, "Real");
  assert.equal(t.activeAt(61000)?.spanish, "Real");
});

test("pendingFallback detecta turnos transcritos sin traducción", () => {
  const t = new SubtitleTimeline();
  t.speechStarted(1000);
  t.speechStopped(2000);
  t.inputTranscript("翻訳なし");

  assert.equal(t.pendingFallback(3000).length, 0); // aún en gracia (2 s)
  assert.equal(t.pendingFallback(4500).length, 1);

  t.fillFallback(t.entries[0], "Sin traducción");
  assert.equal(t.pendingFallback(9000).length, 0);
  assert.equal(t.entries[0].spanish, "Sin traducción");
});

test("exportación SRT con formato de tiempos correcto", () => {
  const t = new SubtitleTimeline();
  makeTurn(t, { start: 61234, end: 64000, jp: "字幕", es: "Subtítulo" });

  const srt = t.toSrt();
  assert.match(srt, /^1\n00:01:01,234 --> 00:01:05,200\nSubtítulo\n$/m);

  const bilingual = t.toSrt({ bilingual: true });
  assert.match(bilingual, /字幕\nSubtítulo/);
});

test("un turno largo se trocea en subtítulos repartidos en su ventana", () => {
  const t = new SubtitleTimeline();
  const texto = Array.from(
    { length: 6 },
    (_, i) => `Esta es la oración número ${i + 1} del turno largo.`
  ).join(" "); // ~290 caracteres, > 2 trozos
  makeTurn(t, { start: 0, end: 15000, jp: "長い話", es: texto });

  // Al inicio de la ventana se ve el primer trozo, no todo el bloque.
  const first = t.activeAt(500);
  assert.ok(first.spanish.length <= 90);
  assert.ok(texto.startsWith(first.spanish.split(" ")[0]));

  // Más adelante se ve un trozo distinto.
  const later = t.activeAt(12000);
  assert.ok(later);
  assert.notEqual(later.spanish, first.spanish);

  // Concatenados reconstruyen el texto completo (sin perder nada).
  const chunks = t.chunksFor(0);
  const joined = chunks.map((c) => c.spanish).join(" ").replace(/\s+/g, " ");
  assert.equal(joined, texto.replace(/\s+/g, " "));
});

test("mientras el turno sigue abierto se muestra la cola en streaming", () => {
  const t = new SubtitleTimeline();
  t.speechStarted(1000);
  t.inputTranscript("話し中");
  t.responseStarted();
  t.outputTextDelta("Texto que va llegando en vivo");

  const live = t.activeAt(2000);
  assert.ok(live.streaming);
  assert.match(live.spanish, /llegando en vivo/);
});

test("el SRT de un turno largo tiene varios cues consecutivos", () => {
  const t = new SubtitleTimeline();
  const texto = "Primera parte de la charla, que sigue y sigue. ".repeat(4).trim();
  makeTurn(t, { start: 0, end: 12000, jp: "長い", es: texto });

  const srt = t.toSrt();
  const cues = srt.trim().split("\n\n");
  assert.ok(cues.length >= 2, `esperaba ≥2 cues, hubo ${cues.length}`);
  // Los cues son consecutivos en el tiempo.
  assert.match(cues[0], /^1\n00:00:00,000/);
  assert.match(cues[1], /^2\n/);
});

test("splitText corta en puntuación y respeta el máximo", () => {
  const pieces = splitText("Uno. Dos. Tres largos enunciados que superan el límite. Cuatro.", 30);
  assert.ok(pieces.every((p) => p.length <= 30));
  assert.equal(pieces.join(" "), "Uno. Dos. Tres largos enunciados que superan el límite. Cuatro.");

  // Japonés sin espacios: corte duro sin perder caracteres.
  const jp = splitText("これはとても長い日本語の文章でスペースがありません".repeat(3), 20);
  assert.ok(jp.every((p) => p.length <= 20));
});

test("srtTime formatea horas, minutos, segundos y milisegundos", () => {
  assert.equal(srtTime(0), "00:00:00,000");
  assert.equal(srtTime(3_723_456), "01:02:03,456");
  assert.equal(srtTime(-5), "00:00:00,000");
});
