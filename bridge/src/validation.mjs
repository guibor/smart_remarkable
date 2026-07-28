import crypto from "node:crypto";
import { HttpError } from "./errors.mjs";
import { RESPONSE_ENVELOPE_PROTOCOL_VERSION } from "./response-envelope.mjs";
import { SOURCE_PROVENANCE_PROTOCOL_VERSION } from "./source-provenance.mjs";

export const MAX_HTTP_BODY_BYTES = 9 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const RESPONSE_MODES = new Set(["write_back", "whatsapp_only"]);
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

export function authenticateRequest(authorization, expectedToken) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new HttpError(401, "Bearer bridge token required");
  }
  const received = authorization.slice("Bearer ".length);
  const receivedDigest = crypto.createHash("sha256").update(received).digest();
  const expectedDigest = crypto
    .createHash("sha256")
    .update(expectedToken)
    .digest();
  if (!crypto.timingSafeEqual(receivedDigest, expectedDigest)) {
    throw new HttpError(401, "Invalid bridge token");
  }
}

export function validateRequestHeaders(headers) {
  const mode = headers["x-smart-remarkable-response-mode"];
  if (typeof mode !== "string" || !RESPONSE_MODES.has(mode)) {
    throw new HttpError(
      400,
      "x-smart-remarkable-response-mode must be write_back or whatsapp_only",
    );
  }

  const requestId = headers["x-smart-remarkable-request-id"];
  if (
    typeof requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(requestId)
  ) {
    throw new HttpError(400, "Invalid x-smart-remarkable-request-id");
  }

  const legacySession = headers["x-openclaw-session-key"];
  if (
    legacySession !== undefined &&
    legacySession !== "agent:main:main"
  ) {
    throw new HttpError(400, "OpenClaw session routing is server-controlled");
  }
  const legacyChannel = headers["x-openclaw-message-channel"];
  if (legacyChannel !== undefined && legacyChannel !== "whatsapp") {
    throw new HttpError(400, "OpenClaw channel routing is server-controlled");
  }

  return { mode, requestId };
}

function decodePngDataUrl(value) {
  if (typeof value !== "string" || !value.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new HttpError(400, "Exactly one PNG data URL is required");
  }
  const encoded = value.slice(PNG_DATA_URL_PREFIX.length);
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new HttpError(400, "Selection image is not valid base64");
  }
  const image = Buffer.from(encoded, "base64");
  if (
    image.length < 8 ||
    image.length > MAX_IMAGE_BYTES ||
    image[0] !== 0x89 ||
    image[1] !== 0x50 ||
    image[2] !== 0x4e ||
    image[3] !== 0x47 ||
    image[4] !== 0x0d ||
    image[5] !== 0x0a ||
    image[6] !== 0x1a ||
    image[7] !== 0x0a ||
    image.toString("base64") !== encoded
  ) {
    throw new HttpError(400, "Selection image must be a PNG of at most 6 MiB");
  }
  return { encoded, imageBytes: image.length };
}

export function validateOpenAiBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  if (body.model !== "openclaw/main") {
    throw new HttpError(400, "model must be openclaw/main");
  }
  if (!Array.isArray(body.messages) || body.messages.length !== 1) {
    throw new HttpError(400, "Exactly one user message is required");
  }

  const message = body.messages[0];
  if (
    !message ||
    message.role !== "user" ||
    !Array.isArray(message.content)
  ) {
    throw new HttpError(400, "The request must contain one multimodal user message");
  }

  const textParts = [];
  const images = [];
  for (const part of message.content) {
    if (!part || typeof part !== "object") {
      throw new HttpError(400, "Invalid message content item");
    }
    if (part.type === "text") {
      if (typeof part.text !== "string" || part.text.trim() === "") {
        throw new HttpError(400, "Text content must be non-empty");
      }
      textParts.push(part.text.trim());
      continue;
    }
    if (part.type === "image_url") {
      images.push(decodePngDataUrl(part.image_url?.url));
      continue;
    }
    throw new HttpError(400, "Only text and PNG image_url content is accepted");
  }

  if (textParts.length === 0 || images.length !== 1) {
    throw new HttpError(400, "At least one text item and exactly one PNG are required");
  }

  const selection = {
    model: body.model,
    promptText: textParts.join("\n\n"),
    imageBase64: images[0].encoded,
    imageBytes: images[0].imageBytes,
  };
  selection.fingerprint = crypto
    .createHash("sha256")
    .update(selection.model)
    .update("\0")
    .update(selection.promptText)
    .update("\0")
    .update(selection.imageBase64)
    .update("\0")
    .update(RESPONSE_ENVELOPE_PROTOCOL_VERSION)
    .update("\0")
    .update(SOURCE_PROVENANCE_PROTOCOL_VERSION)
    .digest("hex");
  return Object.freeze(selection);
}
