import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPostAcceptanceErrorResponse,
  buildSuccessResponse,
  PUBLIC_REMARKABLE_DOCUMENT_ERROR,
  REMARKABLE_ARTIFACT_POLICY,
  WHATSAPP_ONLY_RECEIPT,
} from "../src/openai-response.mjs";
import { SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION } from "../src/source-provenance.mjs";

const REQUEST_ID = "smart-remarkable-response-test-0001";
const DOCUMENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const CLOUD_HASH = "a".repeat(64);

function successInput(overrides = {}) {
  return {
    requestId: REQUEST_ID,
    mode: "write_back",
    selectionKind: "ink",
    contextVersion: SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
    text: "Answer that remains available for local write-back.",
    ack: { ok: true },
    finalDelivery: { ok: true },
    remarkableDocument: {
      status: "uploaded",
      name: "OpenClaw response.pdf",
      documentId: DOCUMENT_ID,
      cloudHash: CLOUD_HASH,
      cached: false,
    },
    replayed: false,
    created: 1_725_000_000,
    ...overrides,
  };
}

test("exports the fixed response-PDF artifact policy", () => {
  assert.equal(REMARKABLE_ARTIFACT_POLICY, "response-pdf-cloud-v1");
});

test("serializes an exact uploaded reMarkable response-PDF outcome", () => {
  const result = buildSuccessResponse(
    successInput({
      remarkableDocument: {
        status: "uploaded",
        name: "OpenClaw response.pdf",
        documentId: DOCUMENT_ID.toUpperCase(),
        cloudHash: CLOUD_HASH.toUpperCase(),
        cached: true,
      },
    }),
  );

  assert.equal(result.choices[0].finish_reason, "stop");
  assert.equal(
    result.choices[0].message.content,
    "Answer that remains available for local write-back.",
  );
  assert.deepEqual(result.remarkable_document, {
    requested: true,
    destination: "remarkable_cloud",
    status: "uploaded",
    name: "OpenClaw response.pdf",
    document_id: DOCUMENT_ID,
    cloud_hash: CLOUD_HASH,
    cached: true,
  });
});

test("PDF failure preserves a successful WhatsApp final and local write-back answer", () => {
  const result = buildSuccessResponse(
    successInput({
      remarkableDocument: { status: "failed" },
    }),
  );

  assert.equal(result.choices[0].finish_reason, "stop");
  assert.equal(
    result.choices[0].message.content,
    "Answer that remains available for local write-back.",
  );
  assert.deepEqual(result.openclaw_delivery.final, { status: "sent" });
  assert.deepEqual(result.remarkable_document, {
    requested: true,
    destination: "remarkable_cloud",
    status: "failed",
    error: PUBLIC_REMARKABLE_DOCUMENT_ERROR,
  });
  assert.equal(JSON.stringify(result).includes("provider"), false);
});

test("WhatsApp-only success keeps its receipt while reporting PDF failure", () => {
  const result = buildSuccessResponse(
    successInput({
      mode: "whatsapp_only",
      remarkableDocument: { status: "failed" },
    }),
  );
  assert.equal(result.choices[0].message.content, WHATSAPP_ONLY_RECEIPT);
  assert.equal(result.choices[0].finish_reason, "stop");
  assert.equal(result.remarkable_document.status, "failed");
});

test("post-acceptance errors always report the fixed PDF failure", () => {
  const result = buildPostAcceptanceErrorResponse({
    requestId: REQUEST_ID,
    mode: "write_back",
    selectionKind: "mixed",
    contextVersion: SMART_REMARKABLE_CONTEXT_PROTOCOL_VERSION,
    ack: { ok: true },
    replayed: false,
    created: 1_725_000_000,
  });
  assert.equal(result.choices[0].finish_reason, "error");
  assert.deepEqual(result.remarkable_document, {
    requested: true,
    destination: "remarkable_cloud",
    status: "failed",
    error: PUBLIC_REMARKABLE_DOCUMENT_ERROR,
  });
});

test("success responses require an exact bounded PDF outcome", () => {
  const invalidOutcomes = [
    undefined,
    { status: "failed", error: new Error("private provider detail") },
    { status: "failed", error: "internal detail", debug: true },
    {
      ...successInput().remarkableDocument,
      extra: true,
    },
    {
      ...successInput().remarkableDocument,
      name: "../unsafe.pdf",
    },
    {
      ...successInput().remarkableDocument,
      name: `${"x".repeat(252)}.pdf`,
    },
    {
      ...successInput().remarkableDocument,
      name: ".pdf",
    },
    {
      ...successInput().remarkableDocument,
      name: "not-a-pdf.epub",
    },
    {
      ...successInput().remarkableDocument,
      documentId: "not-a-document-id",
    },
    {
      ...successInput().remarkableDocument,
      cloudHash: "f".repeat(63),
    },
    {
      ...successInput().remarkableDocument,
      cached: "false",
    },
  ];

  for (const remarkableDocument of invalidOutcomes) {
    assert.throws(
      () => buildSuccessResponse(successInput({ remarkableDocument })),
      /Invalid reMarkable response PDF outcome/,
    );
  }
});
