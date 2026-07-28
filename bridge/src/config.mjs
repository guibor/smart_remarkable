import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const INTENDED_SESSION_ROUTING_CONTRACT = "per-sender|main|main";
const INVALID_AGENT_ID_CHARACTERS = /[^a-z0-9_-]+/g;

function readSecretFile(filePath, name) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    throw new Error(`${name} file is not readable: ${filePath}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${name} file is not a regular file: ${filePath}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${name} file must be mode 0600 or stricter: ${filePath}`);
  }
  let value;
  try {
    value = fs.readFileSync(filePath, "utf8").trim();
  } catch {
    throw new Error(`${name} file is not readable: ${filePath}`);
  }
  if (!value) {
    throw new Error(`${name} file is empty: ${filePath}`);
  }
  return value;
}

function readJson(filePath, description) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`${description} is not readable: ${filePath}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${description} is not valid JSON: ${filePath}`);
  }
}

function resolveBridgeToken(env, defaultTokenPath) {
  const inline = env.SMART_REMARKABLE_BRIDGE_TOKEN?.trim();
  if (inline) {
    return inline;
  }
  const tokenFile =
    env.SMART_REMARKABLE_BRIDGE_TOKEN_FILE?.trim() || defaultTokenPath;
  return readSecretFile(tokenFile, "SMART_REMARKABLE_BRIDGE_TOKEN");
}

function resolveGatewayToken(env, openclawConfig, configPath) {
  const inline = env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (inline) {
    return inline;
  }
  const token = openclawConfig?.gateway?.auth?.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error(
      `OpenClaw configuration has no gateway.auth.token: ${configPath}`,
    );
  }
  return token.trim();
}

function normalizeMainKey(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : "main";
}

function normalizeAgentId(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "main";
  }
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) {
    return lowered;
  }
  return (
    lowered
      .replace(INVALID_AGENT_ID_CHARACTERS, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || "main"
  );
}

function resolveIntendedSessionRoutingContract(openclawConfig) {
  const agents = Array.isArray(openclawConfig?.agents?.list)
    ? openclawConfig.agents.list
    : [];
  const defaultAgentId =
    agents.find((agent) => agent?.default)?.id ??
    agents[0]?.id ??
    "main";
  const contract = [
    openclawConfig?.session?.scope ?? "per-sender",
    normalizeMainKey(openclawConfig?.session?.mainKey),
    normalizeAgentId(defaultAgentId),
  ].join("|");
  if (contract !== INTENDED_SESSION_ROUTING_CONTRACT) {
    throw new Error(
      "OpenClaw session routing must remain per-sender|main|main for this bridge",
    );
  }
  return contract;
}

function resolveWhatsappRoute(env, sessionsPath) {
  if (
    env.OPENCLAW_WHATSAPP_TO?.trim() ||
    env.OPENCLAW_WHATSAPP_ACCOUNT_ID?.trim()
  ) {
    throw new Error(
      "WhatsApp route overrides are forbidden; agent:main:main is canonical",
    );
  }

  const sessions = readJson(sessionsPath, "OpenClaw main-agent sessions");
  const mainSession = sessions?.["agent:main:main"];
  const origin = mainSession?.origin;
  if (!origin || typeof origin !== "object") {
    throw new Error(
      `agent:main:main has no origin in OpenClaw sessions: ${sessionsPath}`,
    );
  }
  if (origin.provider !== "whatsapp") {
    throw new Error(
      "agent:main:main origin.provider must be whatsapp for this bridge",
    );
  }
  const chatType = origin.chatType ?? mainSession.chatType;
  if (chatType !== "direct") {
    throw new Error(
      "agent:main:main origin must be a direct WhatsApp conversation",
    );
  }
  if (
    typeof origin.to !== "string" ||
    !origin.to.trim() ||
    typeof origin.accountId !== "string" ||
    !origin.accountId.trim()
  ) {
    throw new Error(
      "agent:main:main WhatsApp origin must include to and accountId",
    );
  }
  return {
    whatsappTo: origin.to.trim(),
    whatsappAccountId: origin.accountId.trim(),
    routeSource: "main-session-origin",
  };
}

function positiveInteger(name, env, fallback) {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  const openclawHome = (
    env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw")
  ).trim();
  const openclawConfigPath = (
    env.OPENCLAW_CONFIG_PATH ?? path.join(openclawHome, "openclaw.json")
  ).trim();
  const openclawSessionsPath = (
    env.OPENCLAW_SESSIONS_PATH ??
    path.join(openclawHome, "agents", "main", "sessions", "sessions.json")
  ).trim();
  const openclawConfig = readJson(
    openclawConfigPath,
    "OpenClaw configuration",
  );
  const expectedSessionRoutingContract =
    resolveIntendedSessionRoutingContract(openclawConfig);
  const defaultBridgeTokenPath = path.join(
    os.homedir(),
    ".config",
    "smart-remarkable-openclaw-bridge",
    "tablet.token",
  );
  const configuredRequestJournalDir =
    env.SMART_REMARKABLE_REQUEST_JOURNAL_DIR?.trim();
  if (
    env.SMART_REMARKABLE_REQUEST_JOURNAL_DIR !== undefined &&
    (!configuredRequestJournalDir ||
      !path.isAbsolute(configuredRequestJournalDir))
  ) {
    throw new Error(
      "SMART_REMARKABLE_REQUEST_JOURNAL_DIR must be an absolute dedicated directory",
    );
  }
  const requestJournalDir =
    configuredRequestJournalDir ??
    path.resolve(
      openclawHome,
      "smart-remarkable-bridge",
      "request-journal-v1",
    );
  if (
    path.parse(requestJournalDir).root === requestJournalDir ||
    path.basename(requestJournalDir) !== "request-journal-v1"
  ) {
    throw new Error(
      "SMART_REMARKABLE_REQUEST_JOURNAL_DIR must end in a dedicated request-journal-v1 directory",
    );
  }

  const bridgeToken = resolveBridgeToken(env, defaultBridgeTokenPath);
  if (
    bridgeToken.length < 43 ||
    bridgeToken.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(bridgeToken)
  ) {
    throw new Error(
      "SMART_REMARKABLE_BRIDGE_TOKEN must be 43-128 base64url characters",
    );
  }

  const gatewayToken = resolveGatewayToken(
    env,
    openclawConfig,
    openclawConfigPath,
  );
  const { whatsappTo, whatsappAccountId, routeSource } =
    resolveWhatsappRoute(env, openclawSessionsPath);
  const host = (env.SMART_REMARKABLE_BRIDGE_HOST ?? "127.0.0.1").trim();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      "SMART_REMARKABLE_BRIDGE_HOST must remain loopback (127.0.0.1, ::1, or localhost)",
    );
  }

  const gatewayUrl = (
    env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789"
  ).trim();
  let parsedGatewayUrl;
  try {
    parsedGatewayUrl = new URL(gatewayUrl);
  } catch {
    throw new Error("OPENCLAW_GATEWAY_URL must be a valid ws:// loopback URL");
  }
  const gatewayHostname = parsedGatewayUrl.hostname.replace(
    /^\[(.*)\]$/,
    "$1",
  );
  if (
    parsedGatewayUrl.protocol !== "ws:" ||
    !LOOPBACK_HOSTS.has(gatewayHostname)
  ) {
    throw new Error("OPENCLAW_GATEWAY_URL must be a ws:// loopback URL");
  }
  const port = positiveInteger("SMART_REMARKABLE_BRIDGE_PORT", env, 18792);
  if (port > 65_535) {
    throw new Error("SMART_REMARKABLE_BRIDGE_PORT must be at most 65535");
  }

  const requestJournalMaxEntries = positiveInteger(
    "SMART_REMARKABLE_REQUEST_JOURNAL_MAX_ENTRIES",
    env,
    20_000,
  );
  if (requestJournalMaxEntries > 100_000) {
    throw new Error(
      "SMART_REMARKABLE_REQUEST_JOURNAL_MAX_ENTRIES must be at most 100000",
    );
  }

  return Object.freeze({
    bridgeToken,
    gatewayToken,
    whatsappTo,
    whatsappAccountId,
    routeSource,
    host,
    port,
    gatewayUrl,
    runTimeoutMs: positiveInteger(
      "SMART_REMARKABLE_RUN_TIMEOUT_MS",
      env,
      600_000,
    ),
    gatewayConnectTimeoutMs: positiveInteger(
      "SMART_REMARKABLE_GATEWAY_CONNECT_TIMEOUT_MS",
      env,
      15_000,
    ),
    sendTimeoutMs: positiveInteger(
      "SMART_REMARKABLE_SEND_TIMEOUT_MS",
      env,
      15_000,
    ),
    sessionKey: "agent:main:main",
    agentId: "main",
    expectedSessionRoutingContract,
    channel: "whatsapp",
    openclawConfigPath,
    openclawSessionsPath,
    requestJournalDir,
    requestJournalMaxEntries,
  });
}
