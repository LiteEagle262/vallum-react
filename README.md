# `@liteeagle226/react`

React 18+ bindings for the Vallum browser client. The package owns the SDK
lifecycle, exposes initialization state and protected fetch helpers through
context, and paints render-only values without placing protected text in the
DOM.

## Install

```sh
npm install @liteeagle226/client @liteeagle226/react react
```

`@liteeagle226/react` declares the core client as a runtime dependency; it is
listed explicitly above so the complete frontend package pair is visible. Add
`@liteeagle226/admission` in the trusted Node backend that issues grants.

Vallum requires a secure browser context with Web Crypto and `fetch`. Importing
the package and server-rendering the provider are safe; client initialization
starts after hydration in a React Effect.

## Add the provider

```tsx
import { VallumProvider } from "@liteeagle226/react";

export function App() {
  return (
    <VallumProvider endpoint="https://app.example.com">
      <Account />
    </VallumProvider>
  );
}
```

The endpoint must be the page's public origin. Route Vallum and the admission
handler through that origin rather than pointing the browser at a separate API
host.

Keep the provider above every component that makes protected requests. Changing
an initialization option disposes the current client and creates a new one.
Unmounting does the same, including React Strict Mode's development-only Effect
probe cycle.

## Make protected requests

Use `useVallum` when the UI needs explicit loading, error, and retry states:

```tsx
import { useEffect, useState } from "react";
import { useVallum } from "@liteeagle226/react";

export function Account() {
  const { client, status, error, retry } = useVallum();
  const [account, setAccount] = useState<unknown>();

  useEffect(() => {
    if (!client) return;

    let active = true;
    void client.fetch("/api/account")
      .then((response) => response.json())
      .then((value) => {
        if (active) setAccount(value);
      });

    return () => {
      active = false;
    };
  }, [client]);

  if (status === "initializing") return <p>Connecting securely…</p>;
  if (status === "error") {
    return (
      <div role="alert">
        <p>{error?.message}</p>
        <button type="button" onClick={retry}>Try again</button>
      </div>
    );
  }

  return <pre>{JSON.stringify(account, null, 2)}</pre>;
}
```

`useVallumClient()` returns the active client or `null`. `useVallumFetch()`
returns a stable fetch-compatible function and rejects calls made before the
client is ready; use the full context when a request should wait for readiness.

## Render-only values

Render-only disclosure values are one-shot pixel references. Pass the original
value directly to `VallumRender`; do not stringify, clone, or interpolate it.

```tsx
import { VallumRender } from "@liteeagle226/react";

<VallumRender
  value={account.recoveryCode}
  fallback={<span aria-hidden="true">••••••••</span>}
  height={24}
/>
```

By default the canvas is labelled only as a protected value. Providing
`accessibleLabel` deliberately re-exposes that text to the accessibility tree,
so gate it on an explicit account-level accessibility preference.

## API

- `VallumProvider` accepts every `VallumClientOptions` field plus `children`.
- `useVallum()` returns `{ client, status, error, retry }`.
- `useVallumClient()` returns `VallumClient | null`.
- `useVallumFetch()` returns a protected fetch-compatible function.
- `VallumRender` paints one render-only reference into a managed canvas host.
- `VallumContext` is exported for advanced integrations.

`clientFactory` is an advanced provider override intended for tests and custom
client construction. It must return a client compatible with `@liteeagle226/client`.

## Security boundary

These bindings do not turn a browser into a trusted enclave. Code controlling
an authenticated browser can instrument requests or inspect reconstructed
application data. Vallum is defense in depth; keep authentication,
authorization, origin isolation, and response minimization in place.
