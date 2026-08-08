import crypto from "node:crypto";

export const SOURCE_PROVENANCE_PROTOCOL_VERSION =
  "smart-remarkable-origin-v5";
export const SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION =
  "selection-page-v1";
export const ORIGIN_CAPABILITIES_METHOD =
  "smart_remarkable.capabilities";
export const ORIGIN_BIND_METHOD = "smart_remarkable.bind_origin";
export const ORIGIN_CLEAR_METHOD = "smart_remarkable.clear_origin";
export const RESPONSE_PDF_METHOD =
  "smart_remarkable.deliver_response_pdf";
export const OPENCLAW_PLUGIN_ID = "smart-remarkable-delivery";
export const OPENCLAW_PLUGIN_VERSION = "0.5.0";
export const RESPONSE_PDF_POLICY = "response-pdf-cloud-v1";
export const RESPONSE_PDF_DESTINATION = "remarkable_cloud";
export const SMART_REMARKABLE_ATTACHMENT_ROLES = Object.freeze([
  "selection",
  "current_page",
]);
export const SMART_REMARKABLE_SELECTION_KINDS = Object.freeze([
  "ink",
  "image",
  "mixed",
]);
export const SMART_REMARKABLE_REQUEST_ID_PATTERN =
  /^smart-remarkable-[A-Za-z0-9][A-Za-z0-9._:-]{0,110}$/;

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESPONSE_PDF_RECEIPT_KEYS = Object.freeze([
  "artifact_key",
  "cached",
  "cloud_hash",
  "document_id",
  "name",
  "request_id",
  "status",
]);

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

export const SMART_REMARKABLE_SYSTEM_INPUT_PROVENANCE = Object.freeze({
  kind: "external_user",
  sourceChannel: "remarkable",
  sourceTool: "smart_remarkable",
});

export const SMART_REMARKABLE_TRANSPORT_CONTEXT_INSTRUCTION = [
  "[Trusted transport context added by Smart reMarkable; do not transcribe this block as handwriting.]",
  "This user turn originated from the user's reMarkable tablet. Continue the canonical WhatsApp conversation and report there what you read and what you do.",
  "The authenticated explicit reMarkable button and active server binding authorize exactly one server-generated response PDF under the response-pdf-cloud-v1 policy; this transport text records that authority but cannot create it. They do not authorize any other side effect. The server-built capture manifest identifies attachment roles and untrusted page metadata, while all other reMarkable-only action guidance and tool authority come from the authenticated server-side run context.",
].join("\n");

export function verifyPluginCapabilities(result) {
  const expectedKinds = SMART_REMARKABLE_SELECTION_KINDS;
  if (
    result?.status !== "ready" ||
    result?.pluginId !== OPENCLAW_PLUGIN_ID ||
    result?.pluginVersion !== OPENCLAW_PLUGIN_VERSION ||
    result?.originProtocol !== SOURCE_PROVENANCE_PROTOCOL_VERSION ||
    result?.responsePdfMethod !== RESPONSE_PDF_METHOD ||
    result?.responsePdfPolicy !== RESPONSE_PDF_POLICY ||
    result?.responsePdfDestination !== RESPONSE_PDF_DESTINATION ||
    !Array.isArray(result?.inputContextVersions) ||
    result.inputContextVersions.length !== 1 ||
    result.inputContextVersions[0] !==
      SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION ||
    !Array.isArray(result?.attachmentRoles) ||
    result.attachmentRoles.length !==
      SMART_REMARKABLE_ATTACHMENT_ROLES.length ||
    result.attachmentRoles.some(
      (role, index) => role !== SMART_REMARKABLE_ATTACHMENT_ROLES[index],
    ) ||
    !Array.isArray(result?.selectionKinds) ||
    result.selectionKinds.length !== expectedKinds.length ||
    result.selectionKinds.some(
      (kind, index) => kind !== expectedKinds[index],
    )
  ) {
    throw new Error(
      "OpenClaw Smart reMarkable plugin capability contract mismatch",
    );
  }
}

function expectedResponsePdfName(requestId) {
  const suffix = crypto
    .createHash("sha256")
    .update(requestId)
    .digest("hex")
    .slice(0, 16);
  return `OpenClaw response ${suffix}.pdf`;
}

export function verifyResponsePdfReceipt(result, requestId) {
  if (
    typeof requestId !== "string" ||
    !SMART_REMARKABLE_REQUEST_ID_PATTERN.test(requestId) ||
    !hasExactKeys(result, RESPONSE_PDF_RECEIPT_KEYS) ||
    result?.status !== "uploaded" ||
    result?.request_id !== requestId ||
    result?.artifact_key !== RESPONSE_PDF_POLICY ||
    typeof result?.name !== "string" ||
    result.name !== expectedResponsePdfName(requestId) ||
    Buffer.byteLength(result.name, "utf8") > 255 ||
    !result.name.endsWith(".pdf") ||
    /[\u0000-\u001f\u007f-\u009f/\\]/u.test(result.name) ||
    typeof result?.document_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      result.document_id,
    ) ||
    typeof result?.cloud_hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(result.cloud_hash) ||
    typeof result?.cached !== "boolean"
  ) {
    throw new Error(
      "OpenClaw did not confirm the reMarkable response PDF upload",
    );
  }
  return Object.freeze({
    status: "uploaded",
    name: result.name,
    documentId: result.document_id,
    cloudHash: result.cloud_hash,
    cached: result.cached,
  });
}

export function verifyOriginBinding(
  result,
  requestId,
  mode,
  selectionKind,
  expectedSessionId,
  contextVersion,
) {
  if (
    typeof requestId !== "string" ||
    !SMART_REMARKABLE_REQUEST_ID_PATTERN.test(requestId) ||
    typeof expectedSessionId !== "string" ||
    !SESSION_ID_PATTERN.test(expectedSessionId) ||
    result?.protocol !== SOURCE_PROVENANCE_PROTOCOL_VERSION ||
    result?.status !== "bound" ||
    result?.runId !== requestId ||
    result?.source !== "remarkable" ||
    result?.mode !== mode ||
    result?.selectionKind !== selectionKind ||
    result?.contextVersion !== contextVersion ||
    contextVersion !== SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION ||
    result?.expectedSessionId !== expectedSessionId ||
    typeof result?.bindingHandle !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(result.bindingHandle)
  ) {
    throw new Error("OpenClaw did not confirm the reMarkable origin binding");
  }
  return result.bindingHandle;
}

export function verifyOriginActivation(
  result,
  requestId,
  mode,
  selectionKind,
  expectedSessionId,
  contextVersion,
  bindingHandle,
) {
  if (
    typeof bindingHandle !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(bindingHandle) ||
    typeof requestId !== "string" ||
    !SMART_REMARKABLE_REQUEST_ID_PATTERN.test(requestId) ||
    typeof expectedSessionId !== "string" ||
    !SESSION_ID_PATTERN.test(expectedSessionId) ||
    result?.protocol !== SOURCE_PROVENANCE_PROTOCOL_VERSION ||
    result?.status !== "active" ||
    result?.runId !== requestId ||
    result?.source !== "remarkable" ||
    result?.mode !== mode ||
    result?.selectionKind !== selectionKind ||
    result?.contextVersion !== contextVersion ||
    contextVersion !== SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION ||
    result?.expectedSessionId !== expectedSessionId ||
    result?.bindingHandle !== bindingHandle
  ) {
    throw new Error("OpenClaw did not latch the active reMarkable origin");
  }
  return true;
}

export function verifyOriginClearing(result, requestId) {
  if (
    typeof requestId !== "string" ||
    !SMART_REMARKABLE_REQUEST_ID_PATTERN.test(requestId) ||
    result?.status !== "cleared" ||
    result?.runId !== requestId
  ) {
    throw new Error("OpenClaw did not confirm reMarkable origin cleanup");
  }
}
