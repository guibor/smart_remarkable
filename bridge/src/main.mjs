import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { loadConfig } from "./config.mjs";
import { createGatewayConnection } from "./gateway-connection.mjs";
import { createHttpServer } from "./http-server.mjs";
import { createBridgeSelectionService } from "./service-runtime.mjs";

const config = loadConfig();
const gateway = await createGatewayConnection({
  GatewayClient,
  config,
});
const service = await createBridgeSelectionService({ gateway, config });
const server = createHttpServer({
  service,
  bridgeToken: config.bridgeToken,
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, config.host, resolve);
});
console.log(
  `Smart Remarkable bridge listening on http://${config.host}:${config.port}`,
);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await new Promise((resolve) => server.close(resolve));
  await service.close();
  await gateway.close();
}

process.once("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});
