// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery, usePrefersReducedMotion } from "./use-media-query";

let matching = new Set<string>();
let listeners: Array<() => void> = [];

beforeEach(() => {
  matching = new Set();
  listeners = [];
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return matching.has(query);
    },
    addEventListener: (_: string, listener: () => void) => listeners.push(listener),
    removeEventListener: (_: string, listener: () => void) => {
      listeners = listeners.filter((item) => item !== listener);
    },
  }));
});

afterEach(() => vi.unstubAllGlobals());

function Probe({ query }: { query: string }) {
  return <span>{String(useMediaQuery(query))}</span>;
}

describe("useMediaQuery", () => {
  it("vaut false au rendu serveur", () => {
    matching.add("(min-width: 1024px)");
    expect(renderToString(<Probe query="(min-width: 1024px)" />)).toBe("<span>false</span>");
  });

  it("lit la requête dans le navigateur et la suit en direct", () => {
    matching.add("(min-width: 1024px)");
    const { result, unmount } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(true);

    matching.clear();
    act(() => listeners.forEach((listener) => listener()));
    expect(result.current).toBe(false);

    unmount();
    expect(listeners).toHaveLength(0);
  });

  it("suit la préférence de mouvement réduit", () => {
    matching.add("(prefers-reduced-motion: reduce)");
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });

  it("vaut false sans matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);
  });
});
