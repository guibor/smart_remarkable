export const SOURCE_PROVENANCE_PROTOCOL_VERSION =
  "smart-remarkable-origin-v1";
export const ORIGIN_BIND_METHOD = "smart_remarkable.bind_origin";
export const ORIGIN_CLEAR_METHOD = "smart_remarkable.clear_origin";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const SMART_REMARKABLE_SYSTEM_INPUT_PROVENANCE = Object.freeze({
  kind: "external_user",
  sourceChannel: "remarkable",
  sourceTool: "smart_remarkable",
});

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
    result?.status !== "bound" ||
    result?.runId !== requestId ||
    result?.source !== "remarkable" ||
    result?.mode !== mode ||
    result?.expectedSessionId !== expectedSessionId
  ) {
    throw new Error("OpenClaw did not confirm the reMarkable origin binding");
  }
}
