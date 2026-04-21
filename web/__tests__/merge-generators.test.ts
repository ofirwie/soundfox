import { describe, it, expect, vi } from "vitest";
import { mergeAsyncGenerators } from "../src/lib/merge-generators";

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function* timedSource(values: Array<{ value: number; delayMs: number }>): AsyncGenerator<number> {
  for (const { value, delayMs } of values) {
    await delay(delayMs);
    yield value;
  }
}

describe("mergeAsyncGenerators", () => {
  it("merges three sources and yields all values", async () => {
    const s1 = timedSource([{ value: 1, delayMs: 10 }, { value: 4, delayMs: 10 }]);
    const s2 = timedSource([{ value: 2, delayMs: 50 }]);
    const s3 = timedSource([{ value: 3, delayMs: 200 }]);

    const results: number[] = [];
    for await (const v of mergeAsyncGenerators([s1, s2, s3])) {
      results.push(v);
    }
    expect(results.sort()).toEqual([1, 2, 3, 4]);
  });

  it("yields fast-source values before slow-source values", async () => {
    const fast = timedSource([{ value: 1, delayMs: 10 }, { value: 2, delayMs: 10 }]);
    const slow = timedSource([{ value: 99, delayMs: 300 }]);

    const results: number[] = [];
    for await (const v of mergeAsyncGenerators([fast, slow])) {
      results.push(v);
    }
    // fast values should appear first
    expect(results[0]).toBe(1);
    expect(results[1]).toBe(2);
    expect(results[2]).toBe(99);
  });

  // NEGATIVE (Rule 11): one source throws mid-stream → sibling sources keep yielding
  it("NEGATIVE: source error does not kill sibling sources", async () => {
    async function* errorSource(): AsyncGenerator<number> {
      yield 10;
      throw new Error("source exploded");
    }
    const good = timedSource([{ value: 1, delayMs: 10 }, { value: 2, delayMs: 50 }]);
    const errored = errorSource();
    const other = timedSource([{ value: 3, delayMs: 20 }]);

    const onError = vi.fn();
    const results: number[] = [];
    for await (const v of mergeAsyncGenerators([good, errored, other], onError)) {
      results.push(v);
    }

    expect(onError).toHaveBeenCalledOnce();
    expect(results).toContain(10); // errored source yielded 10 before throwing
    expect(results).toContain(1);
    expect(results).toContain(2);
    expect(results).toContain(3);
  });

  it("handles a single source", async () => {
    const s = timedSource([{ value: 5, delayMs: 5 }, { value: 6, delayMs: 5 }]);
    const results: number[] = [];
    for await (const v of mergeAsyncGenerators([s])) results.push(v);
    expect(results).toEqual([5, 6]);
  });

  it("returns immediately for empty source list", async () => {
    const results: number[] = [];
    for await (const v of mergeAsyncGenerators<number>([])) results.push(v);
    expect(results).toHaveLength(0);
  });
});
