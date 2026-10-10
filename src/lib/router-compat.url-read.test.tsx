// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  useSearchParams: vi.fn(() => {
    throw new Error("useSearchParams would force client-side rendering");
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  redirect: vi.fn(),
  usePathname: () => "/accompagnement",
  useParams: () => ({}),
  useRouter: () => ({ push: mocks.push, replace: mocks.replace, refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: mocks.useSearchParams,
}));

import { useNavigate } from "./router-compat";

describe("useNavigate", () => {
  beforeEach(() => {
    mocks.push.mockReset();
    mocks.replace.mockReset();
    window.history.replaceState(null, "", "/accompagnement?plan=analyse&utm=x");
  });
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("does not subscribe to the URL while rendering (the page stays server-rendered)", () => {
    expect(() => renderHook(() => useNavigate())).not.toThrow();
    expect(mocks.useSearchParams).not.toHaveBeenCalled();
  });

  it("reads the current query string only when a navigation happens", () => {
    const { result } = renderHook(() => useNavigate());
    // The query changes after render (shallow history update): the latest one is used.
    window.history.replaceState(null, "", "/accompagnement?plan=decouverte");
    result.current({
      search: (previous) => ({ ...previous, refresh: "1" }),
      replace: true,
    });
    expect(mocks.replace).toHaveBeenCalledWith("/accompagnement?plan=decouverte&refresh=1");
  });

  it("navigates to a path given as a string", () => {
    const { result } = renderHook(() => useNavigate());
    result.current("/login");
    expect(mocks.push).toHaveBeenCalledWith("/login");
  });

  it("keeps shallow replacements on the same page free of a server round trip", () => {
    const { result } = renderHook(() => useNavigate());
    const replaceState = vi.spyOn(window.history, "replaceState");
    result.current({ search: { city: "Pau" }, replace: true, shallow: true });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/accompagnement?city=Pau");
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
