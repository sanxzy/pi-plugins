/**
 * Standalone helper for the H2 no-context fallback test.
 *
 * This process must never call `createSessionLogger`, so neither an ambient
 * context nor the global `defaultLogger` exists. The H2 regression asserts the
 * no-context `processWithLog` path stays silent: zero persistence failures and
 * no stderr noise from touching /dev.
 */
import { getPersistenceFailureCount, processWithLog, resetPersistenceFailureCount } from "../src/index.ts";

resetPersistenceFailureCount();
processWithLog({ operation: "warmup.noContext" }, () => {
  // Nested boundaries inherit the no-context fallback logger as the ambient
  // one; today that logger writes to /dev/null and chmods /dev (noise).
  processWithLog({ operation: "warmup.noContext.nested" }, () => "ok");
  return "ok";
});
console.log(`COUNT=${getPersistenceFailureCount()}`);