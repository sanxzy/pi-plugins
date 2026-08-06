import assert from "node:assert/strict";
import { test } from "node:test";
import { createConcurrencyGate } from "../src/infrastructure/pool/concurrency-gate.ts";
import { MAX_CONCURRENCY, MAX_PARALLEL_TASKS } from "../src/shared/constants.ts";

/**
 * Phase 4 concurrency-gate tests.
 *
 * PI executes the tool calls in one model response concurrently, so the
 * 4-child cap must be a shared gate rather than a per-loop limit. These tests
 * drive the pure FIFO gate: no more than `MAX_CONCURRENCY` operations overlap,
 * waiting operations are admitted in FIFO order, and the per-response
 * `MAX_PARALLEL_TASKS` counter rejects responses that exceed the limit. The
 * registry `queued`/`running` transitions are covered by the registry tests and
 * the live `pi -e` verification.
 */

/** Drain the whole microtask chain (release → admit → waiter resume). */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("gate never lets more than MAX_CONCURRENCY operations overlap", async () => {
  const gate = createConcurrencyGate(MAX_CONCURRENCY);
  let active = 0;
  let peak = 0;

  const ops = Array.from({ length: MAX_CONCURRENCY * 2 }, () => {
    const go = deferred<void>();
    const run = gate.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await go.promise; // hold the slot until the test releases it
      active -= 1;
    });
    return { run, go };
  });

  // Start all operations; the first MAX_CONCURRENCY acquire slots, the rest queue.
  await flush();
  assert.equal(gate.activeCount, MAX_CONCURRENCY);
  assert.equal(gate.queuedCount, MAX_CONCURRENCY);

  // Release slots one at a time; peak concurrency must never exceed the cap.
  for (let i = 0; i < ops.length; i += 1) {
    ops[i].go.resolve();
    await flush();
  }
  await Promise.all(ops.map((op) => op.run));
  assert.equal(gate.activeCount, 0);
  assert.equal(gate.queuedCount, 0);
  assert.equal(peak, MAX_CONCURRENCY);
});

test("gate admits queued operations in FIFO order", async () => {
  const gate = createConcurrencyGate(2);
  const order: number[] = [];
  const release = [
    deferred<void>(),
    deferred<void>(),
    deferred<void>(),
    deferred<void>(),
  ];

  const runs = release.map((go, i) =>
    gate.run(async () => {
      order.push(i);
      await go.promise;
    }),
  );

  // First two acquire, last two queue.
  await flush();
  assert.equal(gate.activeCount, 2);
  assert.equal(gate.queuedCount, 2);

  // Free the first slot; the third operation (index 2) must be admitted next.
  release[0].resolve();
  await flush();
  assert.deepEqual(order, [0, 1, 2]);

  release[1].resolve();
  await flush();
  assert.deepEqual(order, [0, 1, 2, 3]);

  release[2].resolve();
  release[3].resolve();
  await flush();
  assert.equal(gate.activeCount, 0);

  await Promise.all(runs);
});

test("gate releases the slot when an operation throws", async () => {
  const gate = createConcurrencyGate(1);
  await assert.rejects(gate.run(async () => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(gate.activeCount, 0);
  assert.equal(gate.queuedCount, 0);
});

test("per-response counter rejects more than MAX_PARALLEL_TASKS task calls", () => {
  const gate = createConcurrencyGate(MAX_CONCURRENCY);

  // The first MAX_PARALLEL_TASKS calls are accepted.
  for (let i = 0; i < MAX_PARALLEL_TASKS; i += 1) {
    assert.equal(gate.countTaskCall(MAX_PARALLEL_TASKS), true);
  }
  assert.equal(gate.parallelTasksInResponse, MAX_PARALLEL_TASKS);

  // The next call in the same response overflows the limit.
  assert.equal(gate.countTaskCall(MAX_PARALLEL_TASKS), false);
  assert.equal(gate.parallelTasksInResponse, MAX_PARALLEL_TASKS + 1);

  // A fresh response (turn_start reset) gets a clean budget.
  gate.resetParallelCount();
  assert.equal(gate.parallelTasksInResponse, 0);
  assert.equal(gate.countTaskCall(MAX_PARALLEL_TASKS), true);
});

test("gate clamps a pathological max concurrency to at least one slot", async () => {
  const gate = createConcurrencyGate(0);
  assert.equal(gate.activeCount, 0);
  const go = deferred<void>();
  const run = gate.run(async () => {
    await go.promise;
  });
  await flush();
  assert.equal(gate.activeCount, 1);
  go.resolve();
  await run;
  assert.equal(gate.activeCount, 0);
});