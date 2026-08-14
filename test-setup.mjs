import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

// Keep every workspace test process away from the user's real pi-c2 home.
// Individual tests may override this for a narrower fixture. Track every
// disposable override so those homes are removed when the test process exits.
const tempRoot = realpathSync(tmpdir());
const disposableHomes = new Set();
const isDisposableHome = (value) => {
  if (typeof value !== "string" || value.length === 0) return false;
  const expanded = value === "~"
    ? homedir()
    : value.startsWith("~/")
      ? join(homedir(), value.slice(2))
      : value;
  const resolved = resolve(expanded);
  const relativePath = relative(tempRoot, resolved);
  return isAbsolute(resolved) && (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath)));
};
const trackEnvironment = (environment) => new Proxy(environment, {
  set(target, property, value) {
    if (property === "PI_C2_TEST_HOME") {
      // Keep the production resolver unaware of the test-only name. The test
      // harness mirrors the disposable value into the production slot while
      // runtime code itself reads only PI_C2_HOME.
      target.PI_C2_HOME = value;
      if (isDisposableHome(value)) disposableHomes.add(resolve(value));
    }
    return Reflect.set(target, property, value);
  },
  deleteProperty(target, property) {
    if (property === "PI_C2_TEST_HOME") delete target.PI_C2_HOME;
    return Reflect.deleteProperty(target, property);
  },
});
process.env = trackEnvironment(process.env);
const testHome = mkdtempSync(join(tmpdir(), "xzy-pi-c2-test-home-"));
process.env.PI_C2_TEST_HOME = testHome;
process.once("exit", () => {
  for (const home of disposableHomes) rmSync(home, { recursive: true, force: true });
});
