import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";

test("sample system service runs unprivileged with one private writable state directory", async () => {
  const unit = await fs.readFile(
    new URL(
      "../systemd/smart-remarkable-openclaw-bridge.service.example",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(unit, /^User=mdf$/m);
  assert.match(unit, /^Group=mdf$/m);
  assert.match(unit, /^Environment=HOME=\/home\/mdf$/m);
  assert.match(
    unit,
    /^WorkingDirectory=\/home\/mdf\/\.local\/share\/smart-remarkable-openclaw-bridge$/m,
  );
  assert.match(
    unit,
    /^ExecStart=\/usr\/bin\/node \/home\/mdf\/\.local\/share\/smart-remarkable-openclaw-bridge\/src\/main\.mjs$/m,
  );
  assert.match(unit, /^ProtectHome=read-only$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^StateDirectory=smart-remarkable-openclaw-bridge$/m);
  assert.match(unit, /^StateDirectoryMode=0700$/m);
  assert.match(
    unit,
    /^Environment=SMART_REMARKABLE_REQUEST_JOURNAL_DIR=%S\/smart-remarkable-openclaw-bridge\/request-journal-v1$/m,
  );
  assert.doesNotMatch(unit, /^ReadWritePaths=%h(?:\s|$)/m);
  assert.doesNotMatch(unit, /(?:After|Wants)=.*openclaw-gateway/);
  assert.match(unit, /^WantedBy=multi-user\.target$/m);
});
