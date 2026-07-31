import assert from "node:assert/strict";
import { test } from "node:test";
import { createGatewayConnection } from "../src/gateway-connection.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("pins requests to the current authenticated Gateway generation", async () => {
  let client;
  class FakeGatewayClient {
    constructor(options) {
      this.options = options;
      this.requests = [];
      this.requestImplementation = async (method) => ({ method });
      client = this;
    }

    start() {
      this.options.onHelloOk({});
    }

    request(method, params, options) {
      this.requests.push({ method, params, options });
      return this.requestImplementation(method, params, options);
    }

    disconnect() {
      this.options.onClose(1006, "connection lost", {
        phase: "post-hello",
      });
    }

    reconnect() {
      this.options.onHelloOk({});
    }

    async stopAndWait() {
      this.options.onClose(1000, "stopped", { phase: "post-hello" });
    }
  }

  const gateway = await createGatewayConnection({
    GatewayClient: FakeGatewayClient,
    config: {
      gatewayUrl: "ws://127.0.0.1:18789",
      gatewayToken: "test-token",
      gatewayConnectTimeoutMs: 100,
    },
    logger: { error() {} },
  });
  assert.equal(gateway.getConnectionGeneration(), 1);
  assert.deepEqual(
    await gateway.requestForGeneration(1, "first", { value: 1 }),
    { method: "first" },
  );

  const connectionEvents = [];
  const unsubscribe = gateway.subscribeConnection((event) => {
    connectionEvents.push(event);
  });
  const pending = deferred();
  client.requestImplementation = () => pending.promise;
  const crossedGeneration = gateway.requestForGeneration(
    1,
    "slow",
    {},
  );
  client.disconnect();
  assert.equal(gateway.getConnectionGeneration(), null);
  await assert.rejects(
    gateway.requestForGeneration(1, "disconnected", {}),
    /generation is unavailable/,
  );

  client.reconnect();
  assert.equal(gateway.getConnectionGeneration(), 2);
  pending.resolve({ status: "old-generation-result" });
  await assert.rejects(crossedGeneration, /connection changed during request/);
  await assert.rejects(
    gateway.requestForGeneration(1, "stale", {}),
    /generation is unavailable/,
  );

  client.requestImplementation = async (method) => ({ method });
  assert.deepEqual(
    await gateway.requestForGeneration(2, "current", {}),
    { method: "current" },
  );
  assert.deepEqual(connectionEvents, [
    { connected: false, generation: null },
    { connected: true, generation: 2 },
  ]);

  unsubscribe();
  await gateway.close();
  assert.equal(gateway.getConnectionGeneration(), null);
});
