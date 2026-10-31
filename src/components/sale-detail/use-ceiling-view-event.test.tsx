// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));

import { useCeilingViewEvent } from "./use-ceiling-view-event";

afterEach(() => {
  cleanup();
  mocks.track.mockClear();
});

describe("useCeilingViewEvent", () => {
  it("ne mesure rien tant que le plafond n'est pas calculé", () => {
    renderHook(() => useCeilingViewEvent(false));
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it("mesure le plafond calculé une fois par chargement de page, sans identifiant", () => {
    const { rerender } = renderHook(({ computed }) => useCeilingViewEvent(computed), {
      initialProps: { computed: false },
    });
    rerender({ computed: true });
    rerender({ computed: true });
    cleanup();
    renderHook(() => useCeilingViewEvent(true));
    expect(mocks.track.mock.calls).toEqual([["ceiling_viewed"]]);
  });
});
