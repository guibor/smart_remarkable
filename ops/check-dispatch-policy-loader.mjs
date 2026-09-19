// Isolated deployment preflight: exercise the installed OpenClaw source-capture
// loader, not merely Node/JITI imports. Never register a plugin or start a service.
// Usage: node check-dispatch-policy-loader.mjs --adapter /candidate/dispatch-policy.mjs
//   --policy /candidate/remarkable-agent-policy.js --service-root /opt/anki-server
//   --openclaw-root /path/to/node_modules/openclaw
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseOptions(args) {
  const options = {};
  const allowed = new Set(["adapter", "policy", "service-root", "openclaw-root"]);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    const value = args[i + 1];
    if (!args[i]?.startsWith("--") || !allowed.has(key) || options[key] ||
        typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
      throw new Error("Expected unique --adapter, --policy, --service-root, and --openclaw-root absolute paths");
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== allowed.size) throw new Error("All four absolute paths are required");
  return options;
}

function copyRegular(source, destination) {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected regular source file: ${source}`);
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o600);
}

function errorChain(error) {
  const seen = new Set();
  const chain = [];
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    chain.push({ name: current.name, code: current.code, message: current.message, stack: current.stack });
  }
  return chain;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const openclaw = options["openclaw-root"];
  const service = options["service-root"];
  const dist = path.join(openclaw, "dist");
  const loaderNames = fs.readdirSync(dist).filter((name) => /^plugin-setup-module-[A-Za-z0-9_-]+\.mjs$/.test(name));
  if (loaderNames.length !== 1) throw new Error("Installed OpenClaw source-capture loader is ambiguous or unavailable");
  const loaderPath = path.join(dist, loaderNames[0]);
  const loaderSource = fs.readFileSync(loaderPath, "utf8");
  const exportName = loaderSource.match(/\bbindPluginInstanceModuleLoader as ([A-Za-z_$][\w$]*)\b/)?.[1];
  if (!exportName) throw new Error("Installed OpenClaw loader no longer exports the reviewed isolated entry point");
  const loader = (await import(pathToFileURL(loaderPath).href))[exportName];
  if (typeof loader !== "function") throw new Error("Installed OpenClaw loader entry point is not callable");
  const openclawVersion = JSON.parse(fs.readFileSync(path.join(openclaw, "package.json"), "utf8")).version;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "smart-policy-loader-preflight-"));
  const disposers = [];
  const moduleDisposers = [];
  try {
    const plugin = path.join(temporary, "plugin");
    const mirror = path.join(temporary, "anki-server");
    fs.mkdirSync(plugin, { mode: 0o700 });
    fs.mkdirSync(mirror, { mode: 0o700 });
    fs.mkdirSync(path.join(mirror, "dist"), { mode: 0o700 });
    const adapterPath = path.join(plugin, "dispatch-policy.mjs");
    const policyPath = path.join(mirror, "dist/remarkable-agent-policy.js");
    copyRegular(options.adapter, adapterPath);
    copyRegular(options.policy, policyPath);
    // Preserve the real service package boundary and its dependency manifest:
    // omitting this incorrectly makes ordinary Node loading look sufficient.
    copyRegular(path.join(service, "package.json"), path.join(mirror, "package.json"));
    for (const name of ["dispatch-user-experience.js", "openclaw-dispatch-support.js"]) {
      copyRegular(path.join(service, "dist", name), path.join(mirror, "dist", name));
    }
    fs.symlinkSync(path.join(service, "node_modules"), path.join(mirror, "node_modules"), "dir");
    fs.writeFileSync(path.join(plugin, "package.json"), JSON.stringify({
      name: "smart-policy-loader-preflight", private: true, type: "module",
    }), { mode: 0o600 });
    let loadModule;
    const instance = {
      pluginId: "isolated-smart-policy-loader-preflight",
      run: (callback) => callback(),
      lifecycle: { onDispose: (callback) => disposers.push(callback) },
      onModuleDispose: (callback) => moduleDisposers.push(callback),
      bindModuleLoader: (callback) => { loadModule = callback; },
      bindModuleLoaderRecovery: () => {},
    };
    loader({ instance, source: adapterPath, rootDir: plugin, origin: "global" });
    if (typeof loadModule !== "function") throw new Error("Installed OpenClaw loader did not bind a module loader");
    const adapter = loadModule(adapterPath);
    const policy = adapter.loadDispatchPolicy({ modulePath: policyPath });
    for (const destination of ["response", "whatsapp"]) {
      const guidance = policy.buildRemarkableAgentGuidance({
        receivedAt: new Date("2026-01-01T00:00:00.000Z"),
        originalLabel: "Original selection image",
        enhancedLabels: ["Supplemental enhanced selection image"],
        destination,
      });
      if (!Array.isArray(guidance) || !guidance.every((line) => typeof line === "string") || !guidance.length) {
        throw new Error(`Shared policy guidance smoke check failed for ${destination}`);
      }
    }
    // Image preprocessing belongs to the plain-Node bridge. The Gateway plugin
    // deliberately never invokes native image processing inside its capture tree.
    console.log(JSON.stringify({
      ok: true, openclawVersion, nodeVersion: process.versions.node,
      policyVersion: policy.REMARKABLE_AGENT_POLICY_VERSION,
      model: policy.REMARKABLE_AGENT_DEFAULT_MODEL,
      thinking: policy.REMARKABLE_AGENT_DEFAULT_THINKING,
      checked: "isolated-captured-adapter-and-shared-policy-only",
    }));
  } finally {
    // Deregister resolver hooks before deleting the captured modules and fixture.
    try {
      for (const dispose of disposers.reverse()) await dispose();
    } finally {
      try {
        for (const dispose of moduleDisposers.reverse()) await dispose();
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, causes: errorChain(error) }));
  process.exitCode = 1;
});
