function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function createGatewayConnection({
  GatewayClient,
  config,
  logger = console,
}) {
  const listeners = new Set();
  const connectionListeners = new Set();
  let readyResolve;
  let readyReject;
  let ready = false;
  let nextConnectionGeneration = 0;
  let connectionGeneration = null;
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const notifyConnectionListeners = () => {
    const snapshot = Object.freeze({
      connected: connectionGeneration !== null,
      generation: connectionGeneration,
    });
    for (const listener of connectionListeners) {
      try {
        listener(snapshot);
      } catch {
        logger.error?.("Gateway connection listener failed");
      }
    }
  };

  const invalidateConnection = () => {
    if (connectionGeneration === null) {
      return;
    }
    connectionGeneration = null;
    notifyConnectionListeners();
  };

  const client = new GatewayClient({
    url: config.gatewayUrl,
    token: config.gatewayToken,
    clientName: "gateway-client",
    clientDisplayName: "smart-remarkable-bridge",
    mode: "backend",
    role: "operator",
    scopes: ["operator.admin"],
    deviceIdentity: null,
    onHelloOk: () => {
      connectionGeneration = ++nextConnectionGeneration;
      notifyConnectionListeners();
      ready = true;
      readyResolve();
    },
    onConnectError: (error) => {
      if (!ready) {
        readyReject(error);
      } else {
        invalidateConnection();
        logger.error?.("OpenClaw Gateway connection error");
      }
    },
    onClose: () => {
      invalidateConnection();
    },
    onEvent: (event) => {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          logger.error?.("Bridge event listener failed");
        }
      }
    },
  });

  client.start();
  await withTimeout(
    readyPromise,
    config.gatewayConnectTimeoutMs,
    "Timed out connecting to OpenClaw Gateway",
  );

  return {
    request(method, params, options) {
      return client.request(method, params, options);
    },
    async requestForGeneration(generation, method, params, options) {
      if (
        !Number.isSafeInteger(generation) ||
        generation <= 0 ||
        generation !== connectionGeneration
      ) {
        throw new Error("OpenClaw Gateway connection generation is unavailable");
      }
      const result = await client.request(method, params, options);
      if (generation !== connectionGeneration) {
        throw new Error("OpenClaw Gateway connection changed during request");
      }
      return result;
    },
    getConnectionGeneration() {
      return connectionGeneration;
    },
    subscribeConnection(listener) {
      if (typeof listener !== "function") {
        throw new Error("Gateway connection listener must be a function");
      }
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      invalidateConnection();
      if (typeof client.stopAndWait === "function") {
        await client.stopAndWait();
      } else {
        client.stop();
      }
    },
  };
}
