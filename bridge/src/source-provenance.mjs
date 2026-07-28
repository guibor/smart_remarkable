export const SOURCE_PROVENANCE_PROTOCOL_VERSION =
  "smart-remarkable-origin-v2";
export const ORIGIN_BIND_METHOD = "smart_remarkable.bind_origin";
export const ORIGIN_CLEAR_METHOD = "smart_remarkable.clear_origin";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const SMART_REMARKABLE_SYSTEM_INPUT_PROVENANCE = Object.freeze({
  kind: "external_user",
  sourceChannel: "remarkable",
  sourceTool: "smart_remarkable",
});

export const SMART_REMARKABLE_TRANSPORT_CONTEXT_INSTRUCTION = [
  "[Trusted transport context added by Smart reMarkable; do not transcribe this block as handwriting.]",
  "This user turn originated from the user's reMarkable tablet. Continue the canonical WhatsApp conversation and report there what you read and what you do.",
  "If the user asks you to create, export, send, add, or place a document on reMarkable, use the available reMarkable document-delivery tool. Never claim delivery unless that tool confirms the upload.",
].join("\n");

export function verifyOriginBinding(
  result,
  requestId,
  mode,
  expectedSessionId,
) {
  if (
    typeof requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(requestId) ||
    typeof expectedSessionId !== "string" ||
    !SESSION_ID_PATTERN.test(expectedSessionId) ||
    result?.protocol !== SOURCE_PROVENANCE_PROTOCOL_VERSION ||
    result?.status !== "bound" ||
    result?.runId !== requestId ||
    result?.source !== "remarkable" ||
    result?.mode !== mode ||
    result?.expectedSessionId !== expectedSessionId ||
    typeof result?.bindingHandle !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(result.bindingHandle)
  ) {
    throw new Error("OpenClaw did not confirm the reMarkable origin binding");
  }
  return result.bindingHandle;
}

export function verifyOriginClearing(result, requestId) {
  if (
    typeof requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(requestId) ||
    result?.status !== "cleared" ||
    result?.runId !== requestId
  ) {
    throw new Error("OpenClaw did not confirm reMarkable origin cleanup");
  }
}
