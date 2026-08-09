import { describe, expect, it, vi } from "vitest";
import type { VallumClient } from "@vallum/client";
import {
  guardAbortSignals,
  initializeVallumClient,
  readGenerationState,
} from "./lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mockClient() {
  return {
    destroy: vi.fn(),
  } as unknown as VallumClient & { destroy: ReturnType<typeof vi.fn> };
}

describe("Vallum client lifecycle", () => {
  it("does not start a generation disposed before initialization begins", async () => {
    const factory = vi.fn(async () => mockClient());
    const initialization = initializeVallumClient(
      factory,
      { endpoint: "https://api.example.com" },
      { onReady: vi.fn(), onError: vi.fn() },
    );

    initialization.dispose();
    await initialization.settled;
    expect(factory).not.toHaveBeenCalled();
  });

  it("publishes a ready client and destroys it during cleanup", async () => {
    const client = mockClient();
    const onReady = vi.fn();
    const onError = vi.fn();
    const initialization = initializeVallumClient(
      async () => client,
      { endpoint: "https://api.example.com" },
      { onReady, onError },
    );

    await initialization.settled;
    expect(onReady).toHaveBeenCalledWith(client);
    expect(onError).not.toHaveBeenCalled();

    initialization.dispose();
    initialization.dispose();
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys a late client without publishing stale state", async () => {
    const pending = deferred<VallumClient>();
    const client = mockClient();
    const onReady = vi.fn();
    const onError = vi.fn();
    const initialization = initializeVallumClient(
      () => pending.promise,
      { endpoint: "https://api.example.com" },
      { onReady, onError },
    );

    await Promise.resolve();
    initialization.dispose();
    pending.resolve(client);
    await initialization.settled;

    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect((client as ReturnType<typeof mockClient>).destroy).toHaveBeenCalledTimes(1);
  });

  it("normalizes non-Error initialization failures", async () => {
    const onError = vi.fn();
    const initialization = initializeVallumClient(
      async () => Promise.reject("network unavailable"),
      { endpoint: "https://api.example.com" },
      { onReady: vi.fn(), onError },
    );

    await initialization.settled;
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toEqual(expect.any(Error));
    expect(onError.mock.calls[0]?.[0].message).toBe("network unavailable");
  });

  it("suppresses an error from a disposed generation", async () => {
    const pending = deferred<VallumClient>();
    const onError = vi.fn();
    const initialization = initializeVallumClient(
      () => pending.promise,
      { endpoint: "https://api.example.com" },
      { onReady: vi.fn(), onError },
    );

    await Promise.resolve();
    initialization.dispose();
    pending.reject(new Error("stale failure"));
    await initialization.settled;
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("render cancellation", () => {
  it("forwards caller aborts without relying on AbortSignal.any and releases listeners", () => {
    const lifecycle = new AbortController();
    const caller = new AbortController();
    const lifecycleRemove = vi.spyOn(lifecycle.signal, "removeEventListener");
    const callerRemove = vi.spyOn(caller.signal, "removeEventListener");
    const reason = new Error("caller cancelled paint");

    const guard = guardAbortSignals(lifecycle.signal, caller.signal);
    caller.abort(reason);

    expect(guard.signal.aborted).toBe(true);
    expect(guard.signal.reason).toBe(reason);
    expect(lifecycleRemove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(callerRemove).toHaveBeenCalledWith("abort", expect.any(Function));
    guard.dispose();
    expect(lifecycleRemove).toHaveBeenCalledTimes(1);
    expect(callerRemove).toHaveBeenCalledTimes(1);
  });

  it("returns the lifecycle signal directly when no second signal is supplied", () => {
    const lifecycle = new AbortController();
    const guard = guardAbortSignals(lifecycle.signal);

    expect(guard.signal).toBe(lifecycle.signal);
    guard.dispose();
    lifecycle.abort("teardown");
    expect(guard.signal.reason).toBe("teardown");
  });
});

describe("provider generations", () => {
  it("hides a ready client synchronously when the provider generation changes", () => {
    const originalGeneration = Symbol("original");
    const nextGeneration = Symbol("next");
    const client = mockClient();
    const pending = { client: null, status: "initializing" as const, error: null };
    const ready = { client, status: "ready" as const, error: null };
    const published = { generation: originalGeneration, value: ready };

    expect(readGenerationState(published, originalGeneration, pending)).toBe(ready);
    expect(readGenerationState(published, nextGeneration, pending)).toBe(pending);
  });
});
