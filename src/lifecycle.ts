import type { VallumClient, VallumClientOptions } from "@vallum/client";

export type VallumClientFactory = (options: VallumClientOptions) => Promise<VallumClient>;

export interface VallumClientInitialization {
  /** Resolves after this initialization either becomes ready, fails, or is superseded. */
  readonly settled: Promise<void>;
  /** Prevents future callbacks and releases a client created by this generation. */
  dispose(): void;
}

export interface VallumClientInitializationCallbacks {
  onReady(client: VallumClient): void;
  onError(error: Error): void;
}

export interface VallumAbortGuard {
  readonly signal: AbortSignal;
  /** Removes forwarding listeners. Safe to call more than once. */
  dispose(): void;
}

export interface VallumGenerationState<T> {
  readonly generation: symbol;
  readonly value: T;
}

/** @internal Returns fail-closed pending state when an async publication belongs to an obsolete provider generation. */
export function readGenerationState<T>(
  published: VallumGenerationState<T>,
  generation: symbol,
  pending: T,
): T {
  return published.generation === generation ? published.value : pending;
}

/**
 * @internal
 *
 * Combines a framework-owned cancellation signal with an optional caller
 * signal without requiring the comparatively new `AbortSignal.any()` API.
 * Forwarding listeners are released as soon as either input aborts, or when
 * the operation explicitly disposes the guard.
 */
export function guardAbortSignals(
  lifecycleSignal: AbortSignal,
  callerSignal?: AbortSignal,
): VallumAbortGuard {
  if (!callerSignal || callerSignal === lifecycleSignal) {
    return { signal: lifecycleSignal, dispose() {} };
  }

  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  let disposed = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const { signal, listener } of listeners) {
      signal.removeEventListener("abort", listener);
    }
    listeners.length = 0;
  };

  const follow = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
    dispose();
  };

  for (const signal of [lifecycleSignal, callerSignal]) {
    if (signal.aborted) {
      follow(signal);
      break;
    }
    const listener = (): void => follow(signal);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }

  return { signal: controller.signal, dispose };
}

/** @internal */
export function initializeVallumClient(
  factory: VallumClientFactory,
  options: VallumClientOptions,
  callbacks: VallumClientInitializationCallbacks,
): VallumClientInitialization {
  let active = true;
  let client: VallumClient | undefined;

  const settled = Promise.resolve().then(async () => {
    // React Strict Mode may dispose the first Effect generation before this
    // microtask runs. Avoid starting an unnecessary network handshake at all.
    if (!active) return;

    let createdClient: VallumClient;
    try {
      createdClient = await factory(options);
    } catch (cause) {
      if (active) callbacks.onError(toError(cause));
      return;
    }

    if (!active) {
      destroyClient(createdClient);
      return;
    }

    client = createdClient;
    callbacks.onReady(createdClient);
  });

  return {
    settled,
    dispose() {
      if (!active) return;
      active = false;

      if (client) {
        destroyClient(client);
        client = undefined;
      }
    },
  };
}

function destroyClient(client: VallumClient): void {
  client.destroy();
}

function toError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  return new Error(typeof cause === "string" ? cause : "Vallum client initialization failed", { cause });
}
