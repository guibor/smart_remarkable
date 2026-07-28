import crypto from "node:crypto";

export const RUN_CONTEXT_CONTROL_STREAM =
  "smart-remarkable-delivery.origin-control";
export const RUN_CONTEXT_CONTROL_SUBSCRIPTION_ID =
  "smart-remarkable-origin-control";
export const DEFAULT_MAX_RUN_CONTEXT_CONTROL_COMMANDS = 128;

const PLUGIN_ID = "smart-remarkable-delivery";
const RUN_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const NAMESPACE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATIONS = new Set(["get", "set", "clear"]);

function unavailable() {
  return new Error("OpenClaw run-context control is unavailable");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireRunId(value) {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    throw unavailable();
  }
  return value;
}

function requireNamespace(value) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !NAMESPACE_PATTERN.test(value)
  ) {
    throw unavailable();
  }
  return value;
}

function validateCommand(command) {
  if (
    !isRecord(command) ||
    !OPERATIONS.has(command.operation)
  ) {
    throw unavailable();
  }
  const normalized = {
    operation: command.operation,
    runId: requireRunId(command.runId),
    namespace: requireNamespace(command.namespace),
  };
  if (command.operation === "set") {
    if (typeof command.value !== "string") {
      throw unavailable();
    }
    normalized.value = command.value;
  } else if (Object.hasOwn(command, "value")) {
    throw unavailable();
  }
  return Object.freeze(normalized);
}

function isExactReceipt(receipt, opId, command) {
  return (
    isRecord(receipt) &&
    receipt.opId === opId &&
    receipt.operation === command.operation &&
    receipt.runId === command.runId &&
    receipt.namespace === command.namespace &&
    receipt.ok === true
  );
}

function nextOpId(randomUUID, commands) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = randomUUID();
    if (
      typeof candidate === "string" &&
      OPERATION_ID_PATTERN.test(candidate) &&
      !commands.has(candidate)
    ) {
      return candidate;
    }
  }
  throw unavailable();
}

/**
 * Create a synchronous bridge to OpenClaw's callback-scoped run-context API.
 *
 * OpenClaw closes ordinary plugin API methods after registration, but
 * emitAgentEvent remains callable. Each operation is therefore held only in
 * this plugin instance's private command map while a secret-free event carries
 * a random operation ID to the registered subscription. The subscription uses
 * its host callback context, records an exact receipt, and returns before event
 * emission completes.
 */
export function createRunContextControl({
  api,
  randomUUID = crypto.randomUUID,
  maxCommands = DEFAULT_MAX_RUN_CONTEXT_CONTROL_COMMANDS,
} = {}) {
  if (
    !api ||
    api.id !== PLUGIN_ID ||
    typeof api.agent?.events?.registerAgentEventSubscription !==
      "function" ||
    typeof api.agent?.events?.emitAgentEvent !== "function" ||
    typeof randomUUID !== "function" ||
    !Number.isSafeInteger(maxCommands) ||
    maxCommands <= 0
  ) {
    throw new Error("Invalid OpenClaw run-context control configuration");
  }

  const commands = new Map();
  const receipts = new Map();

  function recordFailure(opId, command) {
    receipts.set(
      opId,
      Object.freeze({
        opId,
        operation: command.operation,
        runId: command.runId,
        namespace: command.namespace,
        ok: false,
      }),
    );
  }

  function handleControlEvent(event, context) {
    const opId = event?.data?.opId;
    if (
      event?.stream !== RUN_CONTEXT_CONTROL_STREAM ||
      event?.data?.pluginId !== PLUGIN_ID ||
      typeof opId !== "string" ||
      !OPERATION_ID_PATTERN.test(opId) ||
      receipts.has(opId)
    ) {
      return;
    }
    const command = commands.get(opId);
    if (!command || event.runId !== command.runId) {
      return;
    }
    if (
      typeof context?.getRunContext !== "function" ||
      typeof context?.setRunContext !== "function" ||
      typeof context?.clearRunContext !== "function"
    ) {
      recordFailure(opId, command);
      return;
    }

    try {
      if (command.operation === "get") {
        const value = context.getRunContext(command.namespace);
        receipts.set(
          opId,
          Object.freeze({
            opId,
            operation: command.operation,
            runId: command.runId,
            namespace: command.namespace,
            ok: true,
            value,
          }),
        );
        return;
      }

      if (command.operation === "set") {
        context.setRunContext(command.namespace, command.value);
        const value = context.getRunContext(command.namespace);
        if (value !== command.value) {
          recordFailure(opId, command);
          return;
        }
        receipts.set(
          opId,
          Object.freeze({
            opId,
            operation: command.operation,
            runId: command.runId,
            namespace: command.namespace,
            ok: true,
            value,
          }),
        );
        return;
      }

      context.clearRunContext(command.namespace);
      if (context.getRunContext(command.namespace) !== undefined) {
        recordFailure(opId, command);
        return;
      }
      receipts.set(
        opId,
        Object.freeze({
          opId,
          operation: command.operation,
          runId: command.runId,
          namespace: command.namespace,
          ok: true,
        }),
      );
    } catch {
      recordFailure(opId, command);
    }
  }

  api.agent.events.registerAgentEventSubscription({
    id: RUN_CONTEXT_CONTROL_SUBSCRIPTION_ID,
    description:
      "Execute private Smart reMarkable run-context control operations.",
    streams: [RUN_CONTEXT_CONTROL_STREAM],
    handle: handleControlEvent,
  });

  function dispatch(input) {
    const command = validateCommand(input);
    if (commands.size >= maxCommands) {
      throw unavailable();
    }
    const opId = nextOpId(randomUUID, commands);
    commands.set(opId, command);
    try {
      const emitted = api.agent.events.emitAgentEvent({
        runId: command.runId,
        stream: RUN_CONTEXT_CONTROL_STREAM,
        data: { opId },
      });
      if (
        emitted?.emitted !== true ||
        emitted.stream !== RUN_CONTEXT_CONTROL_STREAM
      ) {
        throw unavailable();
      }
      const receipt = receipts.get(opId);
      if (!isExactReceipt(receipt, opId, command)) {
        throw unavailable();
      }
      return receipt;
    } finally {
      receipts.delete(opId);
      commands.delete(opId);
    }
  }

  return Object.freeze({
    getRunContext({ runId, namespace } = {}) {
      return dispatch({
        operation: "get",
        runId,
        namespace,
      }).value;
    },

    setRunContext({ runId, namespace, value } = {}) {
      const receipt = dispatch({
        operation: "set",
        runId,
        namespace,
        value,
      });
      return receipt.value === value;
    },

    clearRunContext({ runId, namespace } = {}) {
      dispatch({
        operation: "clear",
        runId,
        namespace,
      });
      return true;
    },
  });
}
