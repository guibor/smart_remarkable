import path from "node:path";
import { createRequire } from "node:module";

export const DEFAULT_DISPATCH_POLICY_PATH =
  "/opt/anki-server/dist/remarkable-agent-policy.js";
export const DISPATCH_POLICY_VERSION = "remarkable-agent-policy-v1";
const require = createRequire(import.meta.url);

// This adapter references the same deployed module as Dispatch. It deliberately
// contains no copied prompt, image-processing implementation, or model fallback.
export function validateDispatchPolicy(policy) {
  if (
    !policy ||
    policy.REMARKABLE_AGENT_POLICY_VERSION !== DISPATCH_POLICY_VERSION ||
    typeof policy.REMARKABLE_AGENT_DEFAULT_MODEL !== "string" ||
    !/^[a-z][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(
      policy.REMARKABLE_AGENT_DEFAULT_MODEL,
    ) ||
    typeof policy.REMARKABLE_AGENT_DEFAULT_THINKING !== "string" ||
    !["off", "minimal", "low", "medium", "high", "xhigh"].includes(
      policy.REMARKABLE_AGENT_DEFAULT_THINKING,
    ) ||
    typeof policy.buildRemarkableAgentGuidance !== "function" ||
    typeof policy.prepareRemarkableHandwritingPng !== "function" ||
    typeof policy.normalizeRemarkableAgentThinking !== "function"
  ) {
    throw new Error("Shared Dispatch policy is missing or incompatible");
  }
  if (
    policy.normalizeRemarkableAgentThinking(
      policy.REMARKABLE_AGENT_DEFAULT_THINKING,
      policy.REMARKABLE_AGENT_DEFAULT_MODEL,
    ) !== policy.REMARKABLE_AGENT_DEFAULT_THINKING
  ) {
    throw new Error("Shared Dispatch reasoning default is incompatible");
  }
  return Object.freeze({
    REMARKABLE_AGENT_POLICY_VERSION: policy.REMARKABLE_AGENT_POLICY_VERSION,
    REMARKABLE_AGENT_DEFAULT_MODEL: policy.REMARKABLE_AGENT_DEFAULT_MODEL,
    REMARKABLE_AGENT_DEFAULT_THINKING: policy.REMARKABLE_AGENT_DEFAULT_THINKING,
    buildRemarkableAgentGuidance: policy.buildRemarkableAgentGuidance,
    prepareRemarkableHandwritingPng: policy.prepareRemarkableHandwritingPng,
    normalizeRemarkableAgentThinking: policy.normalizeRemarkableAgentThinking,
  });
}

export function loadDispatchPolicy({
  modulePath = process.env.SMART_REMARKABLE_DISPATCH_POLICY_MODULE ||
    DEFAULT_DISPATCH_POLICY_PATH,
  loadModule = require,
} = {}) {
  if (typeof modulePath !== "string" || !path.isAbsolute(modulePath) ||
      modulePath.includes("\0") || typeof loadModule !== "function") {
    throw new Error("Shared Dispatch policy requires an absolute server module path");
  }
  try {
    return validateDispatchPolicy(loadModule(modulePath));
  } catch (cause) {
    throw new Error("Shared Dispatch policy could not be loaded; Smart reMarkable remains unavailable", { cause });
  }
}
