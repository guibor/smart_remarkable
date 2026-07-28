export const RESPONSE_ENVELOPE_PROTOCOL_VERSION =
  "smart-remarkable.response-envelope.v1";
export const MAX_RECEIVED_TEXT_BYTES = 2_048;
export const MAX_RENDERED_RESPONSE_BYTES = 32_768;

export const RESPONSE_ENVELOPE_PROTOCOL_INSTRUCTION = [
  `Response protocol ${RESPONSE_ENVELOPE_PROTOCOL_VERSION}:`,
  "Return exactly one JSON object and nothing else.",
  'The object must contain exactly the keys "received_text" and "response_text", and both values must be non-empty strings.',
  '"received_text" must be a literal transcription of the selected handwriting in the language in which it was written; do not summarize, correct, translate, or guess.',
  'If the handwriting cannot be read confidently, set "received_text" to exactly "[unclear]".',
  '"response_text" must contain the answer or action result intended for the user.',
  "Do not use Markdown code fences. Do not include NUL or other C0/C1 control characters except LF newlines.",
  `"received_text" must be at most ${MAX_RECEIVED_TEXT_BYTES} UTF-8 bytes, and the final rendered message must fit within ${MAX_RENDERED_RESPONSE_BYTES} UTF-8 bytes.`,
].join("\n");

const REQUIRED_KEYS = new Set(["received_text", "response_text"]);
const FORBIDDEN_CONTROL_PATTERN =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;
const CODE_FENCE_PATTERN = /`{3,}|~{3,}/u;
const JSON_WHITESPACE_PATTERN = /[\u0009\u000a\u000d\u0020]/u;

export class ResponseEnvelopeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResponseEnvelopeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ResponseEnvelopeError(code, message);
}

function skipJsonWhitespace(source, start) {
  let index = start;
  while (
    index < source.length &&
    JSON_WHITESPACE_PATTERN.test(source[index])
  ) {
    index += 1;
  }
  return index;
}

function parseJsonString(source, start) {
  if (source[start] !== '"') {
    fail("invalid_json", "Response envelope keys and values must be JSON strings");
  }

  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '"') {
      const token = source.slice(start, index + 1);
      try {
        return {
          value: JSON.parse(token),
          next: index + 1,
        };
      } catch {
        fail("invalid_json", "Response envelope contains an invalid JSON string");
      }
    }

    if (character === "\\") {
      index += 1;
      if (index >= source.length) {
        fail("invalid_json", "Response envelope contains an incomplete JSON escape");
      }
      if (source[index] === "u") {
        const hexadecimal = source.slice(index + 1, index + 5);
        if (hexadecimal.length !== 4 || !/^[0-9a-fA-F]{4}$/u.test(hexadecimal)) {
          fail("invalid_json", "Response envelope contains an invalid Unicode escape");
        }
        index += 5;
        continue;
      }
      if (!'"\\/bfnrt'.includes(source[index])) {
        fail("invalid_json", "Response envelope contains an invalid JSON escape");
      }
      index += 1;
      continue;
    }

    if (character.charCodeAt(0) <= 0x1f) {
      fail("invalid_json", "Response envelope contains an unescaped JSON control character");
    }
    index += 1;
  }

  fail("invalid_json", "Response envelope contains an unterminated JSON string");
}

function parseStrictStringObject(source) {
  if (typeof source !== "string") {
    fail("invalid_json", "Response envelope must be supplied as JSON text");
  }
  if (CODE_FENCE_PATTERN.test(source)) {
    fail("code_fence", "Response envelope must not contain Markdown code fences");
  }

  let index = skipJsonWhitespace(source, 0);
  if (source[index] !== "{") {
    fail("invalid_json", "Response envelope must be a JSON object");
  }
  index = skipJsonWhitespace(source, index + 1);

  const entries = [];
  if (source[index] === "}") {
    index += 1;
  } else {
    while (index < source.length) {
      const key = parseJsonString(source, index);
      index = skipJsonWhitespace(source, key.next);
      if (source[index] !== ":") {
        fail("invalid_json", "Response envelope is missing a key-value separator");
      }
      index = skipJsonWhitespace(source, index + 1);
      const value = parseJsonString(source, index);
      entries.push([key.value, value.value]);
      index = skipJsonWhitespace(source, value.next);

      if (source[index] === "}") {
        index += 1;
        break;
      }
      if (source[index] !== ",") {
        fail("invalid_json", "Response envelope is not a complete JSON object");
      }
      index = skipJsonWhitespace(source, index + 1);
      if (source[index] === "}") {
        fail("invalid_json", "Response envelope must not contain a trailing comma");
      }
    }
  }

  index = skipJsonWhitespace(source, index);
  if (index !== source.length) {
    fail("invalid_json", "Response envelope must contain exactly one JSON object");
  }
  return entries;
}

function normalizeField(name, value) {
  if (typeof value !== "string") {
    fail("invalid_shape", `${name} must be a string`);
  }
  const normalized = value.replaceAll("\r\n", "\n").normalize("NFC");
  if (normalized.length === 0) {
    fail("empty_field", `${name} must be non-empty`);
  }
  if (FORBIDDEN_CONTROL_PATTERN.test(normalized)) {
    fail(
      "control_character",
      `${name} must not contain NUL or C0/C1 controls except LF`,
    );
  }
  if (CODE_FENCE_PATTERN.test(normalized)) {
    fail("code_fence", `${name} must not contain Markdown code fences`);
  }
  return normalized;
}

function normalizeEnvelope(entries) {
  if (entries.length !== REQUIRED_KEYS.size) {
    fail(
      "invalid_shape",
      "Response envelope must contain exactly received_text and response_text",
    );
  }

  const envelope = Object.create(null);
  for (const [key, value] of entries) {
    if (!REQUIRED_KEYS.has(key) || Object.hasOwn(envelope, key)) {
      fail(
        "invalid_shape",
        "Response envelope must contain each required key exactly once",
      );
    }
    envelope[key] = normalizeField(key, value);
  }
  for (const key of REQUIRED_KEYS) {
    if (!Object.hasOwn(envelope, key)) {
      fail(
        "invalid_shape",
        "Response envelope must contain exactly received_text and response_text",
      );
    }
  }

  if (
    Buffer.byteLength(envelope.received_text, "utf8") >
    MAX_RECEIVED_TEXT_BYTES
  ) {
    fail(
      "received_text_too_large",
      `received_text must be at most ${MAX_RECEIVED_TEXT_BYTES} UTF-8 bytes`,
    );
  }

  return Object.freeze({
    received_text: envelope.received_text,
    response_text: envelope.response_text,
  });
}

function entriesFromObject(envelope) {
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope)
  ) {
    fail("invalid_shape", "Response envelope must be an object");
  }
  return Object.keys(envelope).map((key) => [key, envelope[key]]);
}

function renderNormalizedEnvelope(envelope) {
  const prefix =
    envelope.received_text === "[unclear]"
      ? "I could not confidently read the selected handwriting."
      : `I read:\n${envelope.received_text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}`;
  const rendered = `${prefix}\n\n${envelope.response_text}`;
  if (
    Buffer.byteLength(rendered, "utf8") >
    MAX_RENDERED_RESPONSE_BYTES
  ) {
    fail(
      "rendered_response_too_large",
      `Rendered response must be at most ${MAX_RENDERED_RESPONSE_BYTES} UTF-8 bytes`,
    );
  }
  return rendered;
}

export function parseResponseEnvelope(source) {
  const envelope = normalizeEnvelope(parseStrictStringObject(source));
  renderNormalizedEnvelope(envelope);
  return envelope;
}

export function renderResponseEnvelope(envelope) {
  return renderNormalizedEnvelope(normalizeEnvelope(entriesFromObject(envelope)));
}
