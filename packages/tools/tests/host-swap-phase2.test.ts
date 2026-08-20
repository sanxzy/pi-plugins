// @ts-nocheck
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("phase2 red: footer wiring uses host swap primitive instead of overlay for main window", () => {
  const footerSource = readFileSync(join(__dirname, "../src/registrations/footer.ts"), "utf8");
  assert.match(footerSource, /hostSwap|HostSwap|_hostSwapStack|createHostSwapController/, "footer should be wired to host swap primitive, not just overlay");
  const hasHostSwapWiring = /createHostSwapController|_hostSwapStack/.test(footerSource);
  assert.ok(hasHostSwapWiring, "footer must use host swap controller");
});
