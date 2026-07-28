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
  let readyResolve;
  let readyReject;
  let ready = false;
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

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
      ready = true;
      readyResolve();
    },
    onConnectError: (error) => {
      if (!ready) {
        readyReject(error);
      } else {
        logger.error?.("OpenClaw Gateway connection error");
      }
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
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (typeof client.stopAndWait === "function") {
        await client.stopAndWait();
      } else {
        client.stop();
      }
    },
  };
}
