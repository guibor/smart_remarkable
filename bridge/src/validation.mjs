import crypto from "node:crypto";
import { HttpError } from "./errors.mjs";
import { RESPONSE_ENVELOPE_PROTOCOL_VERSION } from "./response-envelope.mjs";
import {
  SMART_REMARKABLE_ATTACHMENT_ROLES,
  SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
  SMART_REMARKABLE_REQUEST_ID_PATTERN,
  SMART_REMARKABLE_SELECTION_KINDS,
  SOURCE_PROVENANCE_PROTOCOL_VERSION,
} from "./source-provenance.mjs";

export const MAX_HTTP_BODY_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_COMBINED_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENT_DISPLAY_NAME_BYTES = 1024;

const RESPONSE_MODES = new Set(["write_back", "whatsapp_only"]);
const SELECTION_KINDS = new Set(SMART_REMARKABLE_SELECTION_KINDS);
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const CONTEXT_KEYS = Object.freeze([
  "document_display_name",
  "page_id",
  "page_image_completeness",
  "page_image_scope",
  "page_index",
  "page_number",
  "version",
]);
const PAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

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
    !SMART_REMARKABLE_REQUEST_ID_PATTERN.test(requestId)
  ) {
    throw new HttpError(400, "Invalid x-smart-remarkable-request-id");
  }

  const selectionKind = headers["x-smart-remarkable-selection-kind"];
  if (
    typeof selectionKind !== "string" ||
    !SELECTION_KINDS.has(selectionKind)
  ) {
    throw new HttpError(
      400,
      "x-smart-remarkable-selection-kind must be ink, image, or mixed",
    );
  }

  const contextVersion =
    headers["x-smart-remarkable-context-version"];
  if (contextVersion !== SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION) {
    throw new HttpError(
      400,
      `x-smart-remarkable-context-version must be ${SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION}`,
    );
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

  return { mode, requestId, selectionKind, contextVersion };
}

function decodePngDataUrl(value, role) {
  if (typeof value !== "string" || !value.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new HttpError(400, `${role} must contain one PNG data URL`);
  }
  const encoded = value.slice(PNG_DATA_URL_PREFIX.length);
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new HttpError(400, `${role} image is not valid base64`);
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
    throw new HttpError(400, `${role} image must be a PNG of at most 6 MiB`);
  }
  return { encoded, imageBytes: image.length };
}

function validateCaptureContext(value, headerContextVersion) {
  if (!hasExactKeys(value, CONTEXT_KEYS)) {
    throw new HttpError(
      400,
      `x_smart_remarkable_context must contain exactly ${CONTEXT_KEYS.join(", ")}`,
    );
  }
  if (
    value.version !== SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION ||
    value.version !== headerContextVersion
  ) {
    throw new HttpError(
      400,
      "Body and header context versions must both be selection-page-v1",
    );
  }

  const documentDisplayName = value.document_display_name;
  if (
    typeof documentDisplayName !== "string" ||
    documentDisplayName.trim() === "" ||
    documentDisplayName !== documentDisplayName.normalize("NFC") ||
    Buffer.from(documentDisplayName, "utf8").toString("utf8") !==
      documentDisplayName ||
    FORBIDDEN_CONTROL_PATTERN.test(documentDisplayName) ||
    Buffer.byteLength(documentDisplayName, "utf8") >
      MAX_DOCUMENT_DISPLAY_NAME_BYTES
  ) {
    throw new HttpError(
      400,
      "document_display_name must be non-empty NFC text without controls and at most 1024 UTF-8 bytes",
    );
  }
  if (typeof value.page_id !== "string" || !PAGE_ID_PATTERN.test(value.page_id)) {
    throw new HttpError(400, "page_id must be a bounded opaque page identity");
  }
  if (
    !Number.isSafeInteger(value.page_index) ||
    value.page_index < 0 ||
    value.page_index > 1_000_000 ||
    !Number.isSafeInteger(value.page_number) ||
    value.page_number !== value.page_index + 1
  ) {
    throw new HttpError(
      400,
      "page_index must be zero-based and page_number must equal page_index + 1",
    );
  }
  if (value.page_image_scope !== "current_page_view") {
    throw new HttpError(
      400,
      "page_image_scope must be current_page_view",
    );
  }
  if (
    value.page_image_completeness !== "full_page" &&
    value.page_image_completeness !== "viewport_only"
  ) {
    throw new HttpError(
      400,
      "page_image_completeness must be full_page or viewport_only",
    );
  }

  return Object.freeze({
    version: value.version,
    documentDisplayName,
    pageId: value.page_id,
    pageIndex: value.page_index,
    pageNumber: value.page_number,
    pageImageScope: value.page_image_scope,
    pageImageCompleteness: value.page_image_completeness,
  });
}

function validateImagePart(part, expectedRole) {
  if (
    !hasExactKeys(part, [
      "image_url",
      "type",
      "x_smart_remarkable_role",
    ]) ||
    part.type !== "image_url" ||
    part.x_smart_remarkable_role !== expectedRole ||
    !hasExactKeys(part.image_url, ["url"])
  ) {
    throw new HttpError(
      400,
      `Image content must be role-tagged and ordered as ${SMART_REMARKABLE_ATTACHMENT_ROLES.join(", ")}`,
    );
  }
  return decodePngDataUrl(part.image_url.url, expectedRole);
}

export function validateOpenAiBody(
  body,
  selectionKind,
  headerContextVersion,
) {
  if (!SELECTION_KINDS.has(selectionKind)) {
    throw new HttpError(
      400,
      "x-smart-remarkable-selection-kind must be ink, image, or mixed",
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  if (
    !hasExactKeys(body, [
      "messages",
      "model",
      "x_smart_remarkable_context",
    ])
  ) {
    throw new HttpError(
      400,
      "Request body must contain exactly model, messages, and x_smart_remarkable_context",
    );
  }
  if (body.model !== "openclaw/main") {
    throw new HttpError(400, "model must be openclaw/main");
  }
  if (!Array.isArray(body.messages) || body.messages.length !== 1) {
    throw new HttpError(400, "Exactly one user message is required");
  }

  const message = body.messages[0];
  if (
    !hasExactKeys(message, ["content", "role"]) ||
    message.role !== "user" ||
    !Array.isArray(message.content) ||
    message.content.length !== 3
  ) {
    throw new HttpError(
      400,
      "The request must contain one user message with exactly three content items",
    );
  }

  const textPart = message.content[0];
  if (
    !hasExactKeys(textPart, ["text", "type"]) ||
    textPart.type !== "text" ||
    typeof textPart.text !== "string" ||
    textPart.text.trim() === ""
  ) {
    throw new HttpError(
      400,
      "The first content item must be exactly one non-empty text item",
    );
  }
  const selectionImage = validateImagePart(
    message.content[1],
    SMART_REMARKABLE_ATTACHMENT_ROLES[0],
  );
  const currentPageImage = validateImagePart(
    message.content[2],
    SMART_REMARKABLE_ATTACHMENT_ROLES[1],
  );
  if (
    selectionImage.imageBytes + currentPageImage.imageBytes >
    MAX_COMBINED_IMAGE_BYTES
  ) {
    throw new HttpError(400, "Combined PNG content must be at most 8 MiB");
  }
  const captureContext = validateCaptureContext(
    body.x_smart_remarkable_context,
    headerContextVersion,
  );

  const selection = {
    model: body.model,
    promptText: textPart.text.trim(),
    selectionImageBase64: selectionImage.encoded,
    selectionImageBytes: selectionImage.imageBytes,
    currentPageImageBase64: currentPageImage.encoded,
    currentPageImageBytes: currentPageImage.imageBytes,
    captureContext,
    selectionKind,
  };
  const fingerprintContext = JSON.stringify({
    version: captureContext.version,
    document_display_name: captureContext.documentDisplayName,
    page_id: captureContext.pageId,
    page_index: captureContext.pageIndex,
    page_number: captureContext.pageNumber,
    page_image_scope: captureContext.pageImageScope,
    page_image_completeness: captureContext.pageImageCompleteness,
  });
  selection.fingerprint = crypto
    .createHash("sha256")
    .update(selection.model)
    .update("\0")
    .update(selection.promptText)
    .update("\0")
    .update("selection")
    .update("\0")
    .update(selection.selectionImageBase64)
    .update("\0")
    .update("current_page")
    .update("\0")
    .update(selection.currentPageImageBase64)
    .update("\0")
    .update(fingerprintContext)
    .update("\0")
    .update(selection.selectionKind)
    .update("\0")
    .update(RESPONSE_ENVELOPE_PROTOCOL_VERSION)
    .update("\0")
    .update(SOURCE_PROVENANCE_PROTOCOL_VERSION)
    .digest("hex");
  return Object.freeze(selection);
}
