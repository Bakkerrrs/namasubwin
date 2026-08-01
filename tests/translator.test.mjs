// Pruebas del armado de payloads de traducción (lógica pura).

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTranslationPayload, TRANSLATE_MODELS } from "../renderer/translator.js";

test("gpt-5.x lleva reasoning_effort none y no temperature", () => {
  const p = buildTranslationPayload("gpt-5.6-luna", [], "こんにちは");
  assert.equal(p.reasoning_effort, "none");
  assert.equal(p.temperature, undefined);
  assert.equal(p.stream, true);
  assert.match(p.messages[1].content, /(sin contexto previo)/);
  assert.match(p.messages[1].content, /こんにちは/);
});

test("modelos clásicos llevan temperature 0.3 sin reasoning_effort", () => {
  const p = buildTranslationPayload("gpt-4o-mini", [], "テスト");
  assert.equal(p.temperature, 0.3);
  assert.equal(p.reasoning_effort, undefined);
});

test("el contexto previo viaja en el prompt del usuario", () => {
  const context = ["JP: 一\nES: Uno", "JP: 二\nES: Dos"];
  const p = buildTranslationPayload("gpt-5.6-luna", context, "三");
  assert.match(p.messages[1].content, /JP: 一\nES: Uno/);
  assert.match(p.messages[1].content, /JP: 二\nES: Dos/);
  assert.match(p.messages[1].content, /ÚNICAMENTE este texto[^]*\n三/);
});

test("la lista de modelos tiene a gpt-5.6-luna como recomendado", () => {
  assert.equal(TRANSLATE_MODELS[0], "gpt-5.6-luna");
});
