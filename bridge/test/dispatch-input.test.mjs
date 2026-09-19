import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareDispatchAttachments, buildDispatchAttachmentContext } from "../src/dispatch-input.mjs";

const selection = { selectionKind: "ink", selectionImageBase64: Buffer.from("selection").toString("base64"), currentPageImageBase64: Buffer.from("page").toString("base64") };
test("Dispatch enhancement is supplemental and preserves exact primary/context bytes", async () => {
  let calls = 0;
  const result = await prepareDispatchAttachments(selection, {
    async prepareRemarkableHandwritingPng(bytes) {
      calls++;
      assert.equal(bytes.toString(), "selection");
      return { png: Buffer.from("enhanced") };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.length, 3);
  assert.equal(result[0].content, selection.selectionImageBase64);
  assert.equal(result[1].content, selection.currentPageImageBase64);
  assert.equal(result[2].fileName, "remarkable-selection-enhanced.png");
  assert.match(buildDispatchAttachmentContext(result), /original remains authoritative/);
});
test("image and mixed selections retain color and do not receive ink thresholding", async () => {
  for (const selectionKind of ["image", "mixed"]) {
    const result = await prepareDispatchAttachments({ ...selection, selectionKind }, {
      prepareRemarkableHandwritingPng() { assert.fail("must not preprocess non-ink"); },
    });
    assert.equal(result.length, 2);
  }
});
test("failed, empty, oversized, and malformed enhancement retains originals", async () => {
  for (const png of [undefined, Buffer.alloc(0), Buffer.alloc(8 * 1024 * 1024 + 1), "not bytes"]) {
    const result = await prepareDispatchAttachments(selection, { async prepareRemarkableHandwritingPng() { return { png }; } });
    assert.equal(result.length, 2);
    assert.equal(result[0].content, selection.selectionImageBase64);
    assert.match(buildDispatchAttachmentContext(result), /No supplemental/);
  }
  assert.equal((await prepareDispatchAttachments(selection, { async prepareRemarkableHandwritingPng() { throw new Error("decoder"); } })).length, 2);
});
