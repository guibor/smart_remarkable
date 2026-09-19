// Test-only transport fixture: production always loads Dispatch's real module.
export const dispatchPolicyFixture = Object.freeze({
  REMARKABLE_AGENT_POLICY_VERSION: "remarkable-agent-policy-v1",
  REMARKABLE_AGENT_DEFAULT_MODEL: "openai/gpt-6-astra",
  REMARKABLE_AGENT_DEFAULT_THINKING: "low",
  normalizeRemarkableAgentThinking: (thinking) => thinking,
  buildRemarkableAgentGuidance: ({ receivedAt, originalLabel, enhancedLabels, destination }) => [
    `SHARED_POLICY_FIXTURE receipt=${receivedAt.toISOString()} original=${originalLabel} enhancements=${enhancedLabels.join(",")} destination=${destination}`,
  ],
  prepareRemarkableHandwritingPng: async () => {
    throw new Error("The plugin does not preprocess attachments");
  },
});

// Expose the real module shape for the plugin-entry registration smoke test.
export const {
  REMARKABLE_AGENT_POLICY_VERSION,
  REMARKABLE_AGENT_DEFAULT_MODEL,
  REMARKABLE_AGENT_DEFAULT_THINKING,
  normalizeRemarkableAgentThinking,
  buildRemarkableAgentGuidance,
  prepareRemarkableHandwritingPng,
} = dispatchPolicyFixture;
