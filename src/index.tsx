"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  createVallumClient,
  type MountOptions,
  type VallumClient,
  type VallumClientOptions,
} from "@liteeagle226/client";
import {
  guardAbortSignals,
  initializeVallumClient,
  readGenerationState,
  type VallumClientFactory,
  type VallumGenerationState,
} from "./lifecycle.js";

export type { MountOptions, VallumClient, VallumClientOptions } from "@liteeagle226/client";
export type { VallumClientFactory } from "./lifecycle.js";

export type VallumStatus = "initializing" | "ready" | "error";

export interface VallumContextValue {
  /** The active SDK client, or `null` until initialization succeeds. */
  readonly client: VallumClient | null;
  readonly status: VallumStatus;
  readonly error: Error | null;
  /** Disposes the current generation and attempts initialization again. */
  retry(): void;
}

export interface VallumProviderProps extends VallumClientOptions {
  children?: ReactNode;
  /** Advanced override for tests or custom client construction. */
  clientFactory?: VallumClientFactory;
}

interface VallumState {
  client: VallumClient | null;
  status: VallumStatus;
  error: Error | null;
}

const initialState: VallumState = {
  client: null,
  status: "initializing",
  error: null,
};

const useIsomorphicLayoutEffect = typeof globalThis.window === "undefined"
  ? useEffect
  : useLayoutEffect;

export const VallumContext = createContext<VallumContextValue | null>(null);
VallumContext.displayName = "VallumContext";
const VallumGenerationContext = createContext<symbol | null>(null);

/**
 * Owns one Vallum browser client for a React subtree.
 *
 * Initialization happens only in an Effect, making both the module and server
 * render import-safe. Every Effect generation owns its client and destroys it
 * during cleanup, including React Strict Mode's development-only probe cycle.
 */
export function VallumProvider({
  children,
  endpoint,
  fetch: fetchImplementation,
  sessionPath,
  challengePath,
  admissionPath,
  renewalWindowMs,
  clientFactory = createVallumClient,
}: VallumProviderProps) {
  const [attempt, setAttempt] = useState(0);

  const options = useMemo<VallumClientOptions>(
    () => ({
      endpoint,
      ...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
      ...(sessionPath === undefined ? {} : { sessionPath }),
      ...(challengePath === undefined ? {} : { challengePath }),
      ...(admissionPath === undefined ? {} : { admissionPath }),
      ...(renewalWindowMs === undefined ? {} : { renewalWindowMs }),
    }),
    [endpoint, fetchImplementation, sessionPath, challengePath, admissionPath, renewalWindowMs],
  );
  // This token changes during render, so descendants can invalidate protected
  // output in their layout phase even though client initialization and disposal
  // deliberately remain passive effects.
  const generation = useMemo(
    () => Symbol("Vallum provider generation"),
    [attempt, clientFactory, options],
  );
  const [publishedState, setPublishedState] = useState<VallumGenerationState<VallumState>>(() => ({
    generation,
    value: initialState,
  }));
  const state = readGenerationState(publishedState, generation, initialState);

  useEffect(() => {
    setPublishedState({ generation, value: initialState });

    const initialization = initializeVallumClient(clientFactory, options, {
      onReady(client) {
        setPublishedState({
          generation,
          value: { client, status: "ready", error: null },
        });
      },
      onError(error) {
        setPublishedState({
          generation,
          value: { client: null, status: "error", error },
        });
      },
    });

    return initialization.dispose;
  }, [clientFactory, generation, options]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  const value = useMemo<VallumContextValue>(
    () => ({ ...state, retry }),
    [retry, state],
  );

  return (
    <VallumGenerationContext.Provider value={generation}>
      <VallumContext.Provider value={value}>{children}</VallumContext.Provider>
    </VallumGenerationContext.Provider>
  );
}

/** Returns the provider state. Must be called below `VallumProvider`. */
export function useVallum(): VallumContextValue {
  const context = useContext(VallumContext);
  if (!context) throw new Error("useVallum must be used inside a VallumProvider");
  return context;
}

/** Returns the active client, or `null` while initialization is pending or failed. */
export function useVallumClient(): VallumClient | null {
  return useVallum().client;
}

export type VallumFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Returns a stable fetch-compatible function for protected requests.
 * Calls made before the provider is ready reject with an actionable error.
 */
export function useVallumFetch(): VallumFetch {
  const { client, error } = useVallum();

  return useCallback<VallumFetch>(
    (input, init) => {
      if (client) return client.fetch(input, init);
      return Promise.reject(
        error
          ? new Error("Vallum is unavailable because client initialization failed", { cause: error })
          : new Error("Vallum is still initializing"),
      );
    },
    [client, error],
  );
}

export type VallumRenderStatus = "waiting" | "rendering" | "rendered" | "error";

export interface VallumRenderProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "children" | "onError">,
    MountOptions {
  /** A render-only reference returned in reconstructed Vallum data. */
  value: unknown;
  /** Rendered without exposing the protected value while pixels are unavailable. */
  fallback?: ReactNode;
  onError?: (error: Error) => void;
  onRendered?: () => void;
}

/**
 * Paints a one-shot render-only value into a canvas without turning it into DOM text.
 */
export function VallumRender({
  value,
  fallback = null,
  accessibleLabel,
  height,
  signal,
  onError,
  onRendered,
  ...spanProps
}: VallumRenderProps) {
  const client = useVallumClient();
  const providerGeneration = useContext(VallumGenerationContext);
  const hostRef = useRef<HTMLSpanElement>(null);
  const onErrorRef = useRef(onError);
  const onRenderedRef = useRef(onRendered);
  const mountOptionsRef = useRef<MountOptions>({ accessibleLabel, height, signal });
  const paintControllerRef = useRef<AbortController | null>(null);
  const paintGenerationRef = useRef(0);
  const [renderStatus, setRenderStatus] = useState<VallumRenderStatus>("waiting");

  onErrorRef.current = onError;
  onRenderedRef.current = onRendered;
  mountOptionsRef.current = { accessibleLabel, height, signal };

  // Imperative canvas children are outside React's virtual tree. Clear them
  // in the layout phase so pixels from the previous value cannot survive the
  // commit and appear for one frame under a new record or client.
  useIsomorphicLayoutEffect(() => {
    paintGenerationRef.current += 1;
    paintControllerRef.current?.abort(new Error("Vallum render generation was replaced"));
    paintControllerRef.current = null;
    hostRef.current?.replaceChildren();
    setRenderStatus("waiting");
    return () => {
      paintGenerationRef.current += 1;
      paintControllerRef.current?.abort(new Error("Vallum render generation was replaced"));
      paintControllerRef.current = null;
      hostRef.current?.replaceChildren();
    };
  }, [client, providerGeneration, value]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    if (!client) return;

    if (!client.isRenderOnly(value)) {
      const error = new TypeError("VallumRender expected an unconsumed render-only value");
      setRenderStatus("error");
      onErrorRef.current?.(error);
      return;
    }

    let active = true;
    const paintGeneration = paintGenerationRef.current;
    const paintController = new AbortController();
    paintControllerRef.current = paintController;
    const externalSignal = mountOptionsRef.current.signal;
    const paintGuard = guardAbortSignals(paintController.signal, externalSignal);
    setRenderStatus("rendering");

    // Deferring the one-shot value consumption ensures React Strict Mode's
    // setup-cleanup-setup probe can cancel the first setup before it consumes
    // the value. A detached staging element also prevents stale async paints
    // from replacing the current generation's DOM.
    const cancel = schedulePaint(() => {
      const staging = host.ownerDocument.createElement("span");
      const initialOptions = mountOptionsRef.current;
      void Promise.resolve().then(
        () => client.mount(staging, value, { ...initialOptions, signal: paintGuard.signal }),
      ).then(
        (mounted) => {
          paintGuard.dispose();
          if (!active || paintGeneration !== paintGenerationRef.current) return;
          if (!mounted) {
            const error = new Error("The Vallum render-only value could not be mounted; it may already be consumed");
            setRenderStatus("error");
            onErrorRef.current?.(error);
            return;
          }

          const renderedNode = staging.firstElementChild;
          if (renderedNode) applyCanvasPresentation(renderedNode, mountOptionsRef.current);
          host.replaceChildren(...Array.from(staging.childNodes));
          setRenderStatus("rendered");
          onRenderedRef.current?.();
        },
        (cause: unknown) => {
          paintGuard.dispose();
          if (!active || paintGeneration !== paintGenerationRef.current) return;
          const error = cause instanceof Error
            ? cause
            : new Error("Vallum could not paint the render-only value", { cause });
          setRenderStatus("error");
          onErrorRef.current?.(error);
        },
      );
    });

    return () => {
      active = false;
      paintController.abort(new Error("Vallum render generation was replaced"));
      paintGuard.dispose();
      if (paintControllerRef.current === paintController) paintControllerRef.current = null;
      cancel();
    };
  }, [client, providerGeneration, value]);

  useEffect(() => {
    const renderedNode = hostRef.current?.firstElementChild;
    if (renderedNode) applyCanvasPresentation(renderedNode, mountOptionsRef.current);
  }, [accessibleLabel, height]);

  const busy = renderStatus === "waiting" || renderStatus === "rendering";

  return (
    <span
      {...spanProps}
      aria-busy={busy || undefined}
      data-vallum-render-state={renderStatus}
    >
      {renderStatus === "rendered" ? null : fallback}
      <span ref={hostRef} data-vallum-render-host="" />
    </span>
  );
}

function schedulePaint(callback: () => void): () => void {
  if (
    typeof globalThis.requestAnimationFrame === "function"
    && typeof globalThis.cancelAnimationFrame === "function"
  ) {
    const frame = globalThis.requestAnimationFrame(callback);
    return () => globalThis.cancelAnimationFrame(frame);
  }

  const timer = globalThis.setTimeout(callback, 0);
  return () => globalThis.clearTimeout(timer);
}

function applyCanvasPresentation(node: Element, options: MountOptions): void {
  if (node.getAttribute("data-vallum-render") === null) return;
  const sourceWidth = Number(node.getAttribute("data-vallum-source-width"));
  const sourceHeight = Number(node.getAttribute("data-vallum-source-height"));
  if (sourceWidth > 0 && sourceHeight > 0) {
    const cssHeight = options.height ?? sourceHeight / 2;
    const style = (node as HTMLElement).style;
    style.height = `${cssHeight}px`;
    style.width = `${(sourceWidth / sourceHeight) * cssHeight}px`;
  }
  node.setAttribute("aria-label", options.accessibleLabel ?? "protected value");
}
