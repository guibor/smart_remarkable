// Explicit synthetic self-delivery test. Never reads tablet/notebook content.
// This sends one generated test card through the normal WhatsApp/PDF path.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

const [bridgeRoot, mode, confirm] = process.argv.slice(2);
if (!path.isAbsolute(bridgeRoot || "") || !["write_back", "whatsapp_only"].includes(mode) || confirm !== "--send-synthetic-test") {
  throw new Error("usage: BRIDGE_ROOT write_back|whatsapp_only --send-synthetic-test");
}
const require = createRequire("/opt/anki-server/package.json");
const sharp = require("sharp");
const { loadConfig } = await import(pathToFileURL(path.join(bridgeRoot, "src/config.mjs")));
const config = loadConfig();
const requestId = `smart-remarkable-dispatch-parity-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
const expected = "Tablet connection works.";
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="240"><rect width="1000" height="240" fill="white"/><text x="40" y="80" font-size="36" fill="black">Please reply only:</text><text x="40" y="150" font-size="40" fill="black">Tablet connection works.</text></svg>';
const image = (await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64");
const body = {
  model: "openclaw/main",
  messages: [{ role: "user", content: [
    { type: "text", text: "Synthetic deployment test, not personal notebook content. Follow the printed request in the primary selection. Do not perform any external action except the normal automatic response delivery." },
    ...["selection", "current_page"].map((role) => ({ type: "image_url", x_smart_remarkable_role: role, image_url: { url: `data:image/png;base64,${image}` } })),
  ] }],
  x_smart_remarkable_context: { version: "selection-page-v1", document_display_name: "Synthetic installation check", page_id: "synthetic-check", page_index: 0, page_number: 1, page_image_scope: "current_page_view", page_image_completeness: "full_page" },
};
console.log(JSON.stringify({ stage: "sending", requestId, mode, synthetic: true }));
const response = await fetch("http://127.0.0.1:18792/v1/chat/completions", {
  // Canonical history and first-run tool preparation can exceed three minutes.
  // Match the bridge's bounded run budget plus delivery cleanup; do not launch
  // a second request merely because a shorter diagnostic client timed out.
  method: "POST", redirect: "error", signal: AbortSignal.timeout(660_000),
  headers: { authorization: `Bearer ${config.bridgeToken}`, "content-type": "application/json", "x-smart-remarkable-response-mode": mode, "x-smart-remarkable-request-id": requestId, "x-smart-remarkable-selection-kind": "ink", "x-smart-remarkable-context-version": "selection-page-v1", "x-openclaw-session-key": "agent:main:main", "x-openclaw-message-channel": "whatsapp" },
  body: JSON.stringify(body),
});
const result = await response.json();
const text = result.choices?.[0]?.message?.content;
const receipt = {
  requestId, mode, http: response.status,
  acknowledgement: result.openclaw_delivery?.acknowledgement?.status,
  final: result.openclaw_delivery?.final?.status,
  pdf: result.remarkable_document?.status,
  expectedOutput: mode === "write_back" ? text === expected : text === "OpenClaw handled this selection through WhatsApp.",
  replayed: result.x_smart_remarkable?.replayed,
};
console.log(JSON.stringify(receipt));
if (response.status !== 200 || receipt.acknowledgement !== "sent" || receipt.final !== "sent" || receipt.pdf !== "uploaded" || !receipt.expectedOutput || receipt.replayed !== false) process.exitCode = 1;
