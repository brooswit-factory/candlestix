import { describe, expect, test } from "bun:test";
import { createMutationQueue } from "../../src/mutation-queue";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A critical section shaped exactly like `agent-actions.ts`'s own verbs:
 * read the whole shared value, wait (simulating the real `await`s a load
 * and a save each cost), then write back a value computed from the STALE
 * copy read at the top — the textbook lost-update race. This is the
 * negative control the ticket asks for: it must demonstrate what removing
 * serialization looks like, not just assert a mutex object exists.
 */
function makeRacyAppend(shared: { items: string[] }) {
  return async (item: string): Promise<void> => {
    const current = shared.items; // "load"
    await sleep(10); // simulates the real async I/O window createAgent/renameAgent await between load and save
    shared.items = [...current, item]; // "save" — clobbers a concurrent writer's own save if it read the same `current`
  };
}

describe("mutation-queue", () => {
  test("WITHOUT the queue: concurrent racy appends lose an update (negative control)", async () => {
    const shared = { items: [] as string[] };
    const racyAppend = makeRacyAppend(shared);

    await Promise.all([racyAppend("a"), racyAppend("b")]);

    // Both calls read `shared.items` as `[]` before either wrote back, so
    // whichever "save" ran last overwrote the other's — this is EXACTLY
    // the failure mode CNDLX-27 section 5 describes ("two concurrent
    // creates or renames can silently lose one"). Asserting length 1 here
    // is what proves this test can actually observe the race, which is
    // what makes the "WITH the queue" test below meaningful rather than
    // vacuous.
    expect(shared.items.length).toBe(1);
  });

  test("WITH the queue: concurrent racy appends both land", async () => {
    const shared = { items: [] as string[] };
    const racyAppend = makeRacyAppend(shared);
    const queue = createMutationQueue();

    await Promise.all([queue.run(() => racyAppend("a")), queue.run(() => racyAppend("b"))]);

    // The exact same racy critical section as above, run through the
    // queue instead of directly — now BOTH land, because call 2's body
    // does not start (and so does not read `shared.items`) until call 1's
    // has fully settled.
    expect(shared.items.length).toBe(2);
    expect(new Set(shared.items)).toEqual(new Set(["a", "b"]));
  });

  test("serializes many concurrent calls, not just two", async () => {
    const shared = { items: [] as string[] };
    const racyAppend = makeRacyAppend(shared);
    const queue = createMutationQueue();

    const N = 20;
    await Promise.all(Array.from({ length: N }, (_, i) => queue.run(() => racyAppend(`item-${i}`))));

    expect(shared.items.length).toBe(N);
    expect(new Set(shared.items).size).toBe(N);
  });

  test("a rejected call does not wedge the queue for later calls", async () => {
    const queue = createMutationQueue();
    const order: string[] = [];

    const failing = queue.run(async () => {
      order.push("first-start");
      throw new Error("boom");
    });

    const succeeding = queue.run(async () => {
      order.push("second-start");
      return "ok";
    });

    await expect(failing).rejects.toThrow("boom");
    await expect(succeeding).resolves.toBe("ok");
    expect(order).toEqual(["first-start", "second-start"]);
  });

  test("preserves FIFO order even when earlier calls are slower", async () => {
    const queue = createMutationQueue();
    const order: number[] = [];

    const calls = [
      queue.run(async () => {
        await sleep(30);
        order.push(1);
      }),
      queue.run(async () => {
        await sleep(5);
        order.push(2);
      }),
      queue.run(async () => {
        order.push(3);
      }),
    ];

    await Promise.all(calls);
    expect(order).toEqual([1, 2, 3]);
  });
});
