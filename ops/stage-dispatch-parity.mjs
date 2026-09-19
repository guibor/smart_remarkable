// Prepare a content-addressed, non-secret deployment bundle. Reads live file
// hashes only; never changes the server or packages auth/session data.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const anki = "/Users/mdf/code/personal/anki-server";
const id = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const stage = path.join(repo, "tmp", `dispatch-parity-${id}`);
const bridgeRoot = "/home/mdf/.local/share/smart-remarkable-openclaw-bridge";
const pluginRoot = "/home/mdf/.openclaw/extensions/smart-remarkable-delivery";
const entries = [];
for (const name of ["main-http.js", "openclaw-handwriting-support.js", "remarkable-agent-policy.js"]) {
  entries.push({ local: path.join(anki, "dist", name), destination: `/opt/anki-server/dist/${name}` });
}
for (const name of ["main.mjs", "selection-service.mjs", "service-runtime.mjs", "source-provenance.mjs", "validation.mjs", "dispatch-input.mjs"]) {
  entries.push({ local: path.join(repo, "bridge/src", name), destination: `${bridgeRoot}/src/${name}` });
}
for (const name of ["index.mjs", "run-context-control.mjs", "remarkable-upload.mjs", "dispatch-policy.mjs", "package.json", "openclaw.plugin.json"]) {
  for (const root of [pluginRoot, `${bridgeRoot}/openclaw-plugin`]) entries.push({ local: path.join(repo, "bridge/openclaw-plugin", name), destination: `${root}/${name}` });
}
const protectedFiles = [
  ["dispatch-user-experience.js", "ab0001ec375d5eb54da6e7820b5817f3cb29903ed4623ea88e2c825d67af1dca"],
  ["dispatch-filename-title.js", "439b8d16ae98018be45341effd525fc623d05d00d2b68320bef50db9b320c9ba"],
  ["remarkable-research-handwriting.js", "67bd80a7ce65beb1a5d88c43fc42b911530d5be1dafefefacc81b355cfb0f012"],
  ["openclaw-dispatch-support.js", "451cfed7617e65db8ab992b5768d0418c308a22f0912b176613c012f0fc6088a"],
  ["multilingual-pdf.js", "64d5831e713c710e96b6dc0e67ae87dc7f1a25ab4e4af0e958d8375fac981d34"],
].map(([name, sha256]) => ({ path: `/opt/anki-server/dist/${name}`, sha256 }));
const paths = [...entries.map((entry) => entry.destination), ...protectedFiles.map((entry) => entry.path)];
const remoteScript = `const fs=require('fs'),crypto=require('crypto');const out={};for(const p of ${JSON.stringify(paths)}){try{const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink())throw Error('unsafe');out[p]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}catch(e){if(e.code!=='ENOENT')throw e;out[p]=null;}}console.log(JSON.stringify(out));`;
const before = JSON.parse(execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "md-server", "node -"], { input: remoteScript, encoding: "utf8", timeout: 15_000 }));
for (const item of protectedFiles) if (before[item.path] !== item.sha256) throw new Error(`Protected release changed: ${item.path}`);
if (before["/opt/anki-server/dist/main-http.js"] !== "ce8d96fb2e901eb05ae01e81239e48320dc1a3f5ff8a2a842544931a3458e86f") throw new Error("Dispatch release preimage changed");
fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
const files = entries.map((entry, index) => {
  const stat = fs.lstatSync(entry.local);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe candidate file");
  const source = `${String(index).padStart(2, "0")}-${path.basename(entry.local)}`;
  fs.copyFileSync(entry.local, path.join(stage, source));
  fs.chmodSync(path.join(stage, source), 0o600);
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(entry.local)).digest("hex");
  return { source, destination: entry.destination, sha256, beforeSha256: before[entry.destination] };
});
fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify({ transactionId: id, files, protected: protectedFiles }, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ stage, transactionId: id, files }, null, 2));
