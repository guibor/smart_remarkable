import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildResponseEnvelopeProtocolInstruction,
  MAX_RECEIVED_TEXT_BYTES,
  MAX_RENDERED_RESPONSE_BYTES,
  parseResponseEnvelope,
  renderResponseEnvelope,
  RESPONSE_ENVELOPE_PROTOCOL_INSTRUCTION,
  RESPONSE_ENVELOPE_PROTOCOL_VERSION,
  ResponseEnvelopeError,
} from "../src/response-envelope.mjs";

function json(receivedText, responseText = "Answer") {
  return JSON.stringify({
    received_text: receivedText,
    response_text: responseText,
  });
}

function assertEnvelopeError(action, code) {
  assert.throws(
    action,
    (error) =>
      error instanceof ResponseEnvelopeError && error.code === code,
  );
}

test("exports a versioned, self-contained protocol instruction", () => {
  assert.match(RESPONSE_ENVELOPE_PROTOCOL_VERSION, /\.v2$/u);
  assert.match(
    RESPONSE_ENVELOPE_PROTOCOL_INSTRUCTION,
    new RegExp(RESPONSE_ENVELOPE_PROTOCOL_VERSION.replaceAll(".", "\\."), "u"),
  );
  assert.match(RESPONSE_ENVELOPE_PROTOCOL_INSTRUCTION, /received_text/u);
  assert.match(RESPONSE_ENVELOPE_PROTOCOL_INSTRUCTION, /response_text/u);
  assert.match(RESPONSE_ENVELOPE_PROTOCOL_INSTRUCTION, /\[unclear\]/u);
  assert.match(RESPONSE_ENVELOPE_PROTOCOL_INSTRUCTION, /nothing else/u);
  assert.match(RESPONSE_ENVELOPE_PROTOCOL_INSTRUCTION, /code fences/u);
  const imageInstruction =
    buildResponseEnvelopeProtocolInstruction("image");
  const mixedInstruction =
    buildResponseEnvelopeProtocolInstruction("mixed");
  assert.match(imageInstruction, /factual description/u);
  assert.match(imageInstruction, /no legible text/u);
  assert.match(mixedInstruction, /handwritten and printed text/u);
  assert.match(mixedInstruction, /non-text visual content/u);
  assert.equal(
    imageInstruction.includes("selected handwriting"),
    false,
  );
  assert.throws(
    () => buildResponseEnvelopeProtocolInstruction("photo"),
    /must be ink, image, or mixed/u,
  );
});

test("parses exact keys in either order and returns an immutable envelope", () => {
  const envelope = parseResponseEnvelope(
    '{"response_text":"A","received_text":"B"}',
  );
  assert.deepEqual(envelope, {
    received_text: "B",
    response_text: "A",
  });
  assert.equal(Object.isFrozen(envelope), true);
  assert.throws(() => {
    envelope.received_text = "changed";
  }, TypeError);
});

test("normalizes CRLF to LF and Unicode text to NFC", () => {
  const envelope = parseResponseEnvelope(
    json("Cafe\u0301\r\nline two", "Re\u0301ponse\r\nnext"),
  );
  assert.deepEqual(envelope, {
    received_text: "Café\nline two",
    response_text: "Réponse\nnext",
  });
  assert.equal(
    renderResponseEnvelope(envelope),
    "I read:\n> Café\n> line two\n\nRéponse\nnext",
  );
});

test("renders every received line as one quoted block followed by the answer", () => {
  assert.equal(
    renderResponseEnvelope({
      received_text: "line one\n\nline three",
      response_text: "The answer.",
    }),
    "I read:\n> line one\n> \n> line three\n\nThe answer.",
  );
});

test("renders exact unclear sentinel as an explicit inability statement", () => {
  const rendered = renderResponseEnvelope(
    parseResponseEnvelope(json("[unclear]", "Please write it again.")),
  );
  assert.equal(
    rendered,
    "I could not confidently read the selection.\n\nPlease write it again.",
  );
  assert.doesNotMatch(rendered, /> \[unclear\]/u);

  assert.equal(
    renderResponseEnvelope({
      received_text: "[Unclear]",
      response_text: "Case matters.",
    }),
    "I read:\n> [Unclear]\n\nCase matters.",
  );
});

test("rejects non-JSON, code-fenced, trailing, and non-object output", () => {
  for (const source of [
    "",
    "not json",
    "[]",
    "null",
    '```json\n{"received_text":"x","response_text":"y"}\n```',
    '~~~json\n{"received_text":"x","response_text":"y"}\n~~~',
    '{"received_text":"x","response_text":"y"} trailing',
    '{"received_text":"x","response_text":"y",}',
    '{"received_text":"x" "response_text":"y"}',
  ]) {
    assert.throws(() => parseResponseEnvelope(source), ResponseEnvelopeError);
  }
  assertEnvelopeError(
    () =>
      parseResponseEnvelope(
        '{"received_text":"escaped \\u0060\\u0060\\u0060","response_text":"y"}',
      ),
    "code_fence",
  );
});

test("requires exactly two unique decoded keys and string values", () => {
  for (const source of [
    "{}",
    '{"received_text":"x"}',
    '{"response_text":"y"}',
    '{"received_text":"x","response_text":"y","extra":"z"}',
    '{"received_text":"x","received_text":"again","response_text":"y"}',
    '{"received_text":"x","received_\\u0074ext":"again","response_text":"y"}',
    '{"received_text":1,"response_text":"y"}',
    '{"received_text":"x","response_text":null}',
  ]) {
    assertEnvelopeError(
      () => parseResponseEnvelope(source),
      source.includes(":1") || source.includes(":null")
        ? "invalid_json"
        : "invalid_shape",
    );
  }
  assertEnvelopeError(
    () =>
      renderResponseEnvelope({
        received_text: "x",
        response_text: "y",
        extra: "z",
      }),
    "invalid_shape",
  );
});

test("requires both strings to be non-empty without silently trimming them", () => {
  assertEnvelopeError(
    () => parseResponseEnvelope(json("", "answer")),
    "empty_field",
  );
  assertEnvelopeError(
    () => parseResponseEnvelope(json("received", "")),
    "empty_field",
  );
  assert.deepEqual(parseResponseEnvelope(json(" ", " ")), {
    received_text: " ",
    response_text: " ",
  });
});

test("allows LF but rejects every other C0/C1 control after JSON decoding", () => {
  assert.equal(
    parseResponseEnvelope(json("one\ntwo", "three\nfour")).received_text,
    "one\ntwo",
  );
  assert.equal(
    parseResponseEnvelope(json("one\r\ntwo", "answer")).received_text,
    "one\ntwo",
  );

  const forbiddenCodePoints = [
    ...Array.from({ length: 0x20 }, (_, codePoint) => codePoint).filter(
      (codePoint) => codePoint !== 0x0a,
    ),
    ...Array.from({ length: 0x21 }, (_, offset) => 0x7f + offset),
  ];
  for (const codePoint of forbiddenCodePoints) {
    const control = String.fromCodePoint(codePoint);
    assertEnvelopeError(
      () => parseResponseEnvelope(json(`before${control}after`, "answer")),
      "control_character",
    );
    assertEnvelopeError(
      () => parseResponseEnvelope(json("received", `before${control}after`)),
      "control_character",
    );
  }
});

test("enforces the received_text UTF-8 byte limit at the exact boundary", () => {
  const twoByteCharacter = "é";
  const exact = twoByteCharacter.repeat(MAX_RECEIVED_TEXT_BYTES / 2);
  assert.equal(
    Buffer.byteLength(parseResponseEnvelope(json(exact)).received_text, "utf8"),
    MAX_RECEIVED_TEXT_BYTES,
  );
  assertEnvelopeError(
    () => parseResponseEnvelope(json(`${exact}a`)),
    "received_text_too_large",
  );
});

test("enforces the rendered UTF-8 byte limit at the exact boundary", () => {
  const receivedText = "x";
  const prefix = "I read:\n> x\n\n";
  const exactResponse = "a".repeat(
    MAX_RENDERED_RESPONSE_BYTES - Buffer.byteLength(prefix, "utf8"),
  );
  const exactEnvelope = parseResponseEnvelope(
    json(receivedText, exactResponse),
  );
  assert.equal(
    Buffer.byteLength(renderResponseEnvelope(exactEnvelope), "utf8"),
    MAX_RENDERED_RESPONSE_BYTES,
  );
  assertEnvelopeError(
    () => parseResponseEnvelope(json(receivedText, `${exactResponse}a`)),
    "rendered_response_too_large",
  );
});

test("rendering validates untrusted object input with the same fail-closed rules", () => {
  assertEnvelopeError(() => renderResponseEnvelope(null), "invalid_shape");
  assertEnvelopeError(
    () =>
      renderResponseEnvelope({
        received_text: "received",
        response_text: "bad\tanswer",
      }),
    "control_character",
  );
  assertEnvelopeError(
    () =>
      renderResponseEnvelope({
        received_text: "received",
        response_text: "```bad```",
      }),
    "code_fence",
  );
});
