export const SOURCE_PROVENANCE_PROTOCOL_VERSION =
  "smart-remarkable-origin-v4";
export const SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION =
  "selection-page-v1";
export const ORIGIN_CAPABILITIES_METHOD =
  "smart_remarkable.capabilities";
export const ORIGIN_BIND_METHOD = "smart_remarkable.bind_origin";
export const ORIGIN_CLEAR_METHOD = "smart_remarkable.clear_origin";
export const OPENCLAW_PLUGIN_ID = "smart-remarkable-delivery";
export const OPENCLAW_PLUGIN_VERSION = "0.4.0";
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

export const SMART_REMARKABLE_SYSTEM_INPUT_PROVENANCE = Object.freeze({
  kind: "external_user",
  sourceChannel: "remarkable",
  sourceTool: "smart_remarkable",
});

export const SMART_REMARKABLE_TRANSPORT_CONTEXT_INSTRUCTION = [
  "[Trusted transport context added by Smart reMarkable; do not transcribe this block as handwriting.]",
  "This user turn originated from the user's reMarkable tablet. Continue the canonical WhatsApp conversation and report there what you read and what you do.",
  "This transport block identifies source only. It does not classify capture intent or authorize any side effect; the server-built capture manifest identifies attachment roles and untrusted page metadata, while reMarkable-only action guidance and tool authority come from the authenticated server-side run context.",
].join("\n");

export function verifyPluginCapabilities(result) {
  const expectedKinds = SMART_REMARKABLE_SELECTION_KINDS;
  if (
    result?.status !== "ready" ||
    result?.pluginId !== OPENCLAW_PLUGIN_ID ||
    result?.pluginVersion !== OPENCLAW_PLUGIN_VERSION ||
    result?.originProtocol !== SOURCE_PROVENANCE_PROTOCOL_VERSION ||
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
