import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { VallumProvider, VallumRender, useVallum } from "./index";

describe("@liteeagle226/react server rendering", () => {
  it("is import-safe and does not initialize during server rendering", () => {
    const clientFactory = vi.fn();
    const html = renderToString(
      <VallumProvider endpoint="https://api.example.com" clientFactory={clientFactory}>
        <p>application</p>
      </VallumProvider>,
    );

    expect(html).toContain("application");
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("exposes deterministic initializing state in SSR output", () => {
    function Status() {
      const vallum = useVallum();
      return <span>{vallum.status}</span>;
    }

    expect(
      renderToString(
        <VallumProvider endpoint="https://api.example.com">
          <Status />
        </VallumProvider>,
      ),
    ).toContain("initializing");
  });

  it("requires hooks to be used under the provider", () => {
    function InvalidConsumer() {
      useVallum();
      return null;
    }

    expect(() => renderToString(<InvalidConsumer />)).toThrow(
      "useVallum must be used inside a VallumProvider",
    );
  });

  it("renders only a safe fallback for render-only values on the server", () => {
    const html = renderToString(
      <VallumProvider endpoint="https://api.example.com">
        <VallumRender value={null} fallback="Protected value" />
      </VallumProvider>,
    );

    expect(html).toContain("Protected value");
    expect(html).toContain("data-vallum-render-state=\"waiting\"");
  });
});
