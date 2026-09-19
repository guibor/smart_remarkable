import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWhatsappReadiness, waitForWhatsappReady } from "../ops/check-dispatch-whatsapp-ready.mjs";

function snapshot(overrides = {}) {
  return {
    channelAccounts: { whatsapp: [{ accountId: "canonical", enabled: true, configured: true, running: true, connected: true, lastConnectedAt: 1 }] },
    eventLoop: { degraded: false, delayP99Ms: 10 },
    ...overrides,
  };
}

test("readiness selects exactly the canonical account and returns public booleans only", () => {
  const result = parseWhatsappReadiness(snapshot(), "canonical");
  assert.equal(result.ready, true);
  assert.equal(Object.values(result).every((value) => typeof value === "boolean"), true);
  assert.equal(parseWhatsappReadiness(snapshot(), "other").ready, false);
  const duplicate = snapshot();
  duplicate.channelAccounts.whatsapp.push({ ...duplicate.channelAccounts.whatsapp[0] });
  assert.equal(parseWhatsappReadiness(duplicate, "canonical").ready, false);
});

test("requires enabled configured running and connected, without guessing absent fields", () => {
  for (const field of ["enabled", "configured", "running", "connected"]) {
    for (const value of [false, undefined]) {
      const payload = snapshot();
      payload.channelAccounts.whatsapp[0][field] = value;
      assert.equal(parseWhatsappReadiness(payload, "canonical").ready, false);
    }
  }
});

test("partial warning and slow event-loop snapshots cannot pass; absent optional metrics can", () => {
  for (const overrides of [
    { partial: true }, { warnings: ["private diagnostic must not leak"] },
    { eventLoop: { degraded: true, delayP99Ms: 10 } },
    { eventLoop: { degraded: false, delayP99Ms: 501 } }, { eventLoop: null },
  ]) {
    assert.equal(parseWhatsappReadiness(snapshot(overrides), "canonical").ready, false);
  }
  assert.equal(parseWhatsappReadiness(snapshot({ eventLoop: undefined, warnings: [], unknownNewField: true }), "canonical").ready, true);
});

function pollingFixture(payloads) {
  let time = 0;
  let calls = 0;
  const gateway = {
    getConnectionGeneration: () => 1,
    async requestForGeneration(generation, method, params, options) {
      assert.equal(generation, 1);
      assert.equal(method, "channels.status");
      assert.deepEqual(params, { channel: "whatsapp", probe: false, timeoutMs: 2_000 });
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 5_000);
      const value = payloads[Math.min(calls++, payloads.length - 1)];
      if (value instanceof Error) throw value;
      return value;
    },
  };
  return { gateway, now: () => time, sleep: async (ms) => { time += ms; }, calls: () => calls };
}

test("requires three successful snapshots separated by five seconds", async () => {
  const fixture = pollingFixture([snapshot()]);
  const result = await waitForWhatsappReady({ ...fixture, accountId: "canonical" });
  assert.equal(result.ready, true);
  assert.equal(fixture.calls(), 3);
  assert.equal(fixture.now(), 10_000);
});

test("RPC errors and changed WhatsApp connection reset the stability samples", async () => {
  const reconnected = snapshot();
  reconnected.channelAccounts.whatsapp[0].lastConnectedAt = 2;
  const fixture = pollingFixture([snapshot(), new Error("private config"), snapshot(), reconnected, reconnected, reconnected]);
  const result = await waitForWhatsappReady({ ...fixture, accountId: "canonical" });
  assert.equal(result.ready, true);
  assert.equal(fixture.calls(), 6);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("an unavailable account times out without sends or unbounded polling", async () => {
  const fixture = pollingFixture([snapshot()]);
  const result = await waitForWhatsappReady({ ...fixture, accountId: "missing", timeoutMs: 12_000 });
  assert.equal(result.ready, false);
  assert.equal(result.stable, false);
  assert.equal(fixture.calls(), 3);
  assert.equal(fixture.now(), 12_000);
});
