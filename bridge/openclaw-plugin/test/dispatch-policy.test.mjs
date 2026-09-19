import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDispatchPolicy, validateDispatchPolicy, DEFAULT_DISPATCH_POLICY_PATH } from "../dispatch-policy.mjs";
import { dispatchPolicyFixture } from "./dispatch-policy-fixture.mjs";

test("loads and freezes the shared module at the default server path", () => {
  let loaded;
  const policy = loadDispatchPolicy({ loadModule: (location) => { loaded = location; return dispatchPolicyFixture; } });
  assert.equal(loaded, DEFAULT_DISPATCH_POLICY_PATH);
  assert.ok(Object.isFrozen(policy));
  assert.equal(policy.buildRemarkableAgentGuidance, dispatchPolicyFixture.buildRemarkableAgentGuidance);
  assert.equal(policy.prepareRemarkableHandwritingPng, dispatchPolicyFixture.prepareRemarkableHandwritingPng);
});

test("supports an explicit server-only path and never falls back", () => {
  let calls = 0;
  assert.throws(() => loadDispatchPolicy({ modulePath: "/private/policy.js", loadModule: () => { calls++; throw new Error("missing"); } }), /remains unavailable/u);
  assert.equal(calls, 1);
  for (const modulePath of ["relative.js", "https://example.org/policy.js", "", "/tmp/\0policy.js"]) {
    assert.throws(() => loadDispatchPolicy({ modulePath, loadModule: () => { throw new Error("must not load"); } }), /absolute server module path/u);
  }
});

test("rejects mismatched policy contracts and incomplete or invalid defaults", () => {
  for (const changes of [
    { REMARKABLE_AGENT_POLICY_VERSION: "older-policy" },
    { REMARKABLE_AGENT_DEFAULT_MODEL: "astra" },
    { REMARKABLE_AGENT_DEFAULT_MODEL: "openai/gpt-6-astra\n" },
    { REMARKABLE_AGENT_DEFAULT_THINKING: "ultra" },
    { buildRemarkableAgentGuidance: undefined },
    { prepareRemarkableHandwritingPng: undefined },
    { normalizeRemarkableAgentThinking: undefined },
    { normalizeRemarkableAgentThinking: () => "minimal" },
  ]) {
    assert.throws(() => validateDispatchPolicy({ ...dispatchPolicyFixture, ...changes }), /incompatible/u);
  }
});
