/**
 * Merge N async generators into one. Yields values as soon as any source produces one.
 * Individual source failures are logged and skipped — they do not kill sibling sources.
 */
export async function* mergeAsyncGenerators<T>(
  sources: Array<AsyncGenerator<T> | AsyncIterable<T>>,
  onSourceError?: (i: number, err: unknown) => void,
): AsyncGenerator<T> {
  const iters = sources.map((s) =>
    (Symbol.asyncIterator in s ? s[Symbol.asyncIterator]() : s) as AsyncIterator<T>,
  );

  const pending: Array<Promise<
    { i: number; res: IteratorResult<T> } | { i: number; err: unknown }
  > | null> = iters.map((it, i) =>
    it.next().then((res) => ({ i, res })).catch((err) => ({ i, err })),
  );

  while (pending.some((p) => p !== null)) {
    const active = pending.filter(
      (p): p is Promise<{ i: number; res: IteratorResult<T> } | { i: number; err: unknown }> =>
        p !== null,
    );
    const winner = await Promise.race(active);
    const i = winner.i;
    if ("err" in winner) {
      onSourceError?.(i, winner.err);
      pending[i] = null;
      continue;
    }
    if (winner.res.done) {
      pending[i] = null;
      continue;
    }
    yield winner.res.value;
    pending[i] = iters[i].next().then((res) => ({ i, res })).catch((err) => ({ i, err }));
  }
}
