// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ scroll: vi.fn() }));
vi.mock("./scroll-to-sale-card", () => ({ scrollToSaleCard: mocks.scroll }));

import { saleCardIdFromHash, useRestoreSaleCard } from "./use-restore-sale-card";

beforeEach(() => mocks.scroll.mockReset());
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("saleCardIdFromHash", () => {
  it("lit l'identifiant de la carte dans l'ancre", () => {
    expect(saleCardIdFromHash("#sale-card-abc-123")).toBe("abc-123");
    expect(saleCardIdFromHash("sale-card-abc%20x")).toBe("abc x");
  });

  it("ignore une autre ancre, une ancre vide ou mal encodée", () => {
    expect(saleCardIdFromHash("")).toBeNull();
    expect(saleCardIdFromHash("#sales-results")).toBeNull();
    expect(saleCardIdFromHash("#sale-card-")).toBeNull();
    expect(saleCardIdFromHash("#sale-card-%E0%A4%A")).toBeNull();
  });
});

describe("useRestoreSaleCard", () => {
  it("défile d'un coup jusqu'à la carte une fois la liste affichée, une seule fois", () => {
    window.history.replaceState(null, "", "/sales?city=Lyon#sale-card-abc-123");
    const { rerender } = renderHook(({ ready }) => useRestoreSaleCard(ready), {
      initialProps: { ready: false },
    });
    expect(mocks.scroll).not.toHaveBeenCalled();

    rerender({ ready: true });
    expect(mocks.scroll).toHaveBeenCalledWith("abc-123", { behavior: "instant" });

    rerender({ ready: false });
    rerender({ ready: true });
    expect(mocks.scroll).toHaveBeenCalledTimes(1);
  });

  it("ne fait rien sans ancre de carte dans l'adresse", () => {
    window.history.replaceState(null, "", "/sales?city=Lyon");
    renderHook(() => useRestoreSaleCard(true));
    expect(mocks.scroll).not.toHaveBeenCalled();
  });
});
