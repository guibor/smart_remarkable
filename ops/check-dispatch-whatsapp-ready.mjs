#!/usr/bin/env node
// Read-only post-startup gate. No channel probes, sends, or service mutations.
// OpenClaw 2026.9.5: channels.status(channel, probe, timeoutMs), with exact
// channelAccounts account snapshots and optional Gateway event-loop health.
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const DEFAULT_BRIDGE_ROOT = "/home/mdf/.local/share/smart-remarkable-openclaw-bridge";
const POLL_MS = 5_000;
const TIMEOUT_MS = 90_000;
const REQUIRED_SAMPLES = 3;
const MAX_EVENT_LOOP_P99_MS = 500;

export function parseWhatsappReadiness(payload, accountId) {
  const accounts = payload?.channelAccounts?.whatsapp;
  const matches = Array.isArray(accounts)
    ? accounts.filter((entry) => entry?.accountId === accountId)
    : [];
  const account = matches.length === 1 ? matches[0] : undefined;
  const eventLoop = payload?.eventLoop;
  const eventLoopPresent = eventLoop !== undefined;
  const eventLoopHealthy = !eventLoopPresent || (
    eventLoop?.degraded === false &&
    Number.isFinite(eventLoop.delayP99Ms) &&
    eventLoop.delayP99Ms >= 0 &&
    eventLoop.delayP99Ms <= MAX_EVENT_LOOP_P99_MS
  );
  const warningsClear = payload?.warnings === undefined || (
    Array.isArray(payload.warnings) && payload.warnings.length === 0
  );
  const publicStatus = {
    accountFound: matches.length === 1,
    enabled: account?.enabled === true,
    configured: account?.configured === true,
    running: account?.running === true,
    connected: account?.connected === true,
    complete: payload?.partial !== true,
    warningsClear,
    eventLoopPresent,
    eventLoopHealthy,
  };
  return {
    ...publicStatus,
    ready: publicStatus.accountFound && publicStatus.enabled &&
      publicStatus.configured && publicStatus.running && publicStatus.connected &&
      publicStatus.complete && warningsClear && eventLoopHealthy,
  };
}

export async function waitForWhatsappReady({
  gateway,
  accountId,
  timeoutMs = TIMEOUT_MS,
  pollMs = POLL_MS,
  requiredSamples = REQUIRED_SAMPLES,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const deadline = now() + timeoutMs;
  let consecutive = 0;
  let previousConnection = null;
  let lastStatus = parseWhatsappReadiness(undefined, accountId);
  while (now() < deadline) {
    try {
      const generation = gateway.getConnectionGeneration();
      const payload = await gateway.requestForGeneration(generation, "channels.status", {
        channel: "whatsapp", probe: false, timeoutMs: 2_000,
      }, { timeoutMs: Math.max(1, Math.min(5_000, deadline - now())) });
      lastStatus = parseWhatsappReadiness(payload, accountId);
      const account = payload?.channelAccounts?.whatsapp?.find((row) => row?.accountId === accountId);
      const connection = `${generation}:${account?.lastConnectedAt ?? "unreported"}`;
      if (connection !== previousConnection) consecutive = 0;
      previousConnection = connection;
      consecutive = lastStatus.ready ? consecutive + 1 : 0;
      if (consecutive >= requiredSamples && now() < deadline) {
        return { ready: true, stable: true, status: lastStatus };
      }
    } catch {
      // RPC errors can carry target/config details; never include them in output.
      consecutive = 0;
      previousConnection = null;
      lastStatus = parseWhatsappReadiness(undefined, accountId);
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(pollMs, remaining));
  }
  return { ready: false, stable: false, status: lastStatus };
}

async function main() {
  const bridgeRoot = process.argv[2] ?? DEFAULT_BRIDGE_ROOT;
  if (!path.isAbsolute(bridgeRoot) || process.argv.length > 3) {
    throw new Error("Invalid bridge path");
  }
  const require = createRequire(path.join(bridgeRoot, "package.json"));
  const { GatewayClient } = await import(pathToFileURL(require.resolve("openclaw/plugin-sdk/gateway-runtime")));
  const { loadConfig } = await import(pathToFileURL(path.join(bridgeRoot, "src/config.mjs")));
  const { createGatewayConnection } = await import(pathToFileURL(path.join(bridgeRoot, "src/gateway-connection.mjs")));
  const config = loadConfig();
  const gateway = await createGatewayConnection({ GatewayClient, config, logger: { error() {} } });
  try {
    const result = await waitForWhatsappReady({ gateway, accountId: config.whatsappAccountId });
    console.log(JSON.stringify(result));
    return result.ready ? 0 : 1;
  } finally {
    await gateway.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code), () => {
    console.log(JSON.stringify({ ready: false, stable: false, diagnosticFailed: true }));
    process.exit(1);
  });
}
