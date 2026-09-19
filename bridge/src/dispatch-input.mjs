// Transport adapter only: interpretation and image processing belong to the
// same server-owned policy module used by Dispatch.
export const DISPATCH_POLICY_VERSION = "remarkable-agent-policy-v1";
export const ENHANCED_SELECTION_NAME = "remarkable-selection-enhanced.png";
const MAX_ENHANCED_BYTES = 8 * 1024 * 1024;

export async function prepareDispatchAttachments(selection, policy) {
  const attachments = [
    { type: "image", mimeType: "image/png", fileName: "remarkable-selection.png", content: selection.selectionImageBase64 },
    { type: "image", mimeType: "image/png", fileName: "remarkable-current-page.png", content: selection.currentPageImageBase64 },
  ];
  // Thresholding is a readability aid for handwriting, not a transformation
  // of photographs or mixed content. Original and page context never change.
  if (selection.selectionKind === "ink") {
    try {
      const enhanced = await policy.prepareRemarkableHandwritingPng(
        Buffer.from(selection.selectionImageBase64, "base64"),
      );
      if (!Buffer.isBuffer(enhanced.png) || enhanced.png.length === 0 || enhanced.png.length > MAX_ENHANCED_BYTES) {
        throw new Error("Invalid enhanced image");
      }
      attachments.push({ type: "image", mimeType: "image/png", fileName: ENHANCED_SELECTION_NAME, content: enhanced.png.toString("base64") });
    } catch {
      // Match Dispatch's fail-open enhancement: never drop the original or
      // log its bytes/content because a supplemental view cannot be made.
    }
  }
  return attachments;
}

export function buildDispatchAttachmentContext(attachments) {
  return attachments.length === 3
    ? `Server-derived readability aid: ${ENHANCED_SELECTION_NAME} is a deterministic stroke-enhanced copy of remarkable-selection.png, not a third user input. Compare it with the primary original; the original remains authoritative. The current-page image is context only.`
    : "No supplemental readability image is attached. Use the primary original; the current-page image is context only.";
}
