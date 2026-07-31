import assert from "node:assert/strict";
import test from "node:test";
import {
  RUN_CONTEXT_CONTROL_STREAM,
  RUN_CONTEXT_CONTROL_SUBSCRIPTION_ID,
  createRunContextControl,
} from "../run-context-control.mjs";

const RUN_ID = "smart-remarkable-control-run-0001";
const NAMESPACE = "smart-remarkable-origin-v3";
const SECRET_VALUE =
  '{"capability":"never-emit-this","bindingHandle":"also-private"}';

function uuidSequence() {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  };
}

function createFixture({
  randomUUID = uuidSequence(),
  maxCommands,
  deliver = "sync",
  mutateContext,
  enrichPluginId = "smart-remarkable-delivery",
} = {}) {
  let subscription;
  const events = [];
  const values = new Map();
  const context = {
    getRunContext(namespace) {
      return values.get(namespace);
    },
    setRunContext(namespace, value) {
      values.set(namespace, value);
    },
    clearRunContext(namespace) {
      values.delete(namespace);
    },
  };
  mutateContext?.(context, values);

  let onEmit;
  const api = {
    id: "smart-remarkable-delivery",
    agent: {
      events: {
        registerAgentEventSubscription(candidate) {
          subscription = candidate;
        },
        emitAgentEvent(event) {
          events.push(structuredClone(event));
          onEmit?.(event);
          const delivered = {
            ...structuredClone(event),
            data: {
              ...structuredClone(event.data),
              pluginId: enrichPluginId,
            },
          };
          if (deliver === "sync") {
            subscription.handle(delivered, context);
          } else if (deliver === "microtask") {
            queueMicrotask(() => subscription.handle(delivered, context));
          }
          return {
            emitted: true,
            stream: event.stream,
          };
        },
      },
    },
  };
  const control = createRunContextControl({
    api,
    randomUUID,
    ...(maxCommands === undefined ? {} : { maxCommands }),
  });
  return {
    control,
    events,
    values,
    subscription,
    setOnEmit(callback) {
      onEmit = callback;
    },
  };
}

test("registers one plugin-owned synchronous control subscription", () => {
  const fixture = createFixture();

  assert.equal(
    fixture.subscription.id,
    RUN_CONTEXT_CONTROL_SUBSCRIPTION_ID,
  );
  assert.deepEqual(
    fixture.subscription.streams,
    [RUN_CONTEXT_CONTROL_STREAM],
  );
  assert.equal(typeof fixture.subscription.handle, "function");
});

test("sets, gets, and clears through callback run context", () => {
  const fixture = createFixture();

  assert.equal(
    fixture.control.setRunContext({
      runId: RUN_ID,
      namespace: NAMESPACE,
      value: SECRET_VALUE,
    }),
    true,
  );
  assert.equal(
    fixture.control.getRunContext({
      runId: RUN_ID,
      namespace: NAMESPACE,
    }),
    SECRET_VALUE,
  );
  assert.equal(
    fixture.control.clearRunContext({
      runId: RUN_ID,
      namespace: NAMESPACE,
    }),
    true,
  );
  assert.equal(
    fixture.control.getRunContext({
      runId: RUN_ID,
      namespace: NAMESPACE,
    }),
    undefined,
  );

  assert.equal(fixture.events.length, 4);
  assert.equal(
    new Set(
      fixture.events.map((event) => event.data.opId),
    ).size,
    4,
  );
  for (const event of fixture.events) {
    assert.equal(event.runId, RUN_ID);
    assert.equal(event.stream, RUN_CONTEXT_CONTROL_STREAM);
    assert.deepEqual(Object.keys(event.data), ["opId"]);
    assert.doesNotMatch(JSON.stringify(event), /never-emit-this/);
    assert.doesNotMatch(JSON.stringify(event), /also-private/);
  }
});

test("fails closed when the subscription receipt is not synchronous", async () => {
  const fixture = createFixture({ deliver: "microtask" });

  assert.throws(
    () =>
      fixture.control.setRunContext({
        runId: RUN_ID,
        namespace: NAMESPACE,
        value: SECRET_VALUE,
      }),
    /run-context control is unavailable/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.values.get(NAMESPACE), undefined);
});

test("fails closed when set read-back does not match", () => {
  const fixture = createFixture({
    mutateContext(context) {
      context.setRunContext = () => {};
    },
  });

  assert.throws(
    () =>
      fixture.control.setRunContext({
        runId: RUN_ID,
        namespace: NAMESPACE,
        value: SECRET_VALUE,
      }),
    /run-context control is unavailable/,
  );
});

test("fails closed when clear read-back still exists", () => {
  const fixture = createFixture({
    mutateContext(context, values) {
      values.set(NAMESPACE, SECRET_VALUE);
      context.clearRunContext = () => {};
    },
  });

  assert.throws(
    () =>
      fixture.control.clearRunContext({
        runId: RUN_ID,
        namespace: NAMESPACE,
      }),
    /run-context control is unavailable/,
  );
});

test("rejects events not attributed to this plugin", () => {
  const fixture = createFixture({ enrichPluginId: "another-plugin" });

  assert.throws(
    () =>
      fixture.control.getRunContext({
        runId: RUN_ID,
        namespace: NAMESPACE,
      }),
    /run-context control is unavailable/,
  );
});

test("bounds in-flight commands and rejects reentrant overflow", () => {
  const fixture = createFixture({ maxCommands: 1 });
  let nestedError;
  fixture.setOnEmit(() => {
    try {
      fixture.control.getRunContext({
        runId: "smart-remarkable-control-run-0002",
        namespace: NAMESPACE,
      });
    } catch (error) {
      nestedError = error;
    }
  });

  assert.equal(
    fixture.control.getRunContext({
      runId: RUN_ID,
      namespace: NAMESPACE,
    }),
    undefined,
  );
  assert.match(
    nestedError?.message ?? "",
    /run-context control is unavailable/,
  );
  assert.equal(fixture.events.length, 1);
});
