// CNDLX-27 section 5: until CNDLX-32, nothing ever called the eight-verb
// action set concurrently — no server existed. Once the API server exists,
// two concurrent requests can each `load -> modify -> save` the durable
// agent set, and the second save can silently clobber the first's change
// (a classic lost-update race: both loads happen before either save).
//
// The daemon becomes the ONLY writer of the agent set once this ships (see
// api/server.ts's own doc comment for what was verified about the
// reconcile loop), so serializing every mutating action inside THIS
// process is sufficient — there is no second process to coordinate with.
//
// This is a plain FIFO promise-chain mutex: every `run` call is appended to
// a tail promise, so call N+1's function body does not start until call
// N's has fully settled (success or failure) — no lock object, no
// semaphore, nothing that could deadlock. A rejection is swallowed only on
// the internal tail (so one failed mutation never wedges the queue for
// later ones); the promise returned to the caller still rejects normally.
export interface MutationQueue {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createMutationQueue(): MutationQueue {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(fn);
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  };
}
