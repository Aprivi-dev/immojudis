// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseSalePurchaseReturn,
  SALE_PURCHASE_POLL_DELAYS_MS,
  useSalePurchaseReturn,
  withoutSalePurchaseReturn,
} from "./use-sale-unlock-purchase-return";

const total = SALE_PURCHASE_POLL_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);

function visit(search: string) {
  window.history.replaceState(null, "", `/sales/vente-1${search}#debloquer`);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  visit("");
});

describe("retour du paiement d'une vente à l'unité", () => {
  it("lit `unlock_checkout=success|cancelled` et retire les paramètres du retour", () => {
    expect(parseSalePurchaseReturn("?unlock_checkout=success")).toBe("success");
    expect(parseSalePurchaseReturn("?unlock_checkout=cancelled")).toBe("cancelled");
    expect(parseSalePurchaseReturn("?unlock_checkout=autre")).toBeNull();
    expect(
      withoutSalePurchaseReturn({
        pathname: "/sales/vente-1",
        search: "?from=%2Fsales&unlock_checkout=success&session_id=cs_1",
        hash: "#debloquer",
      }),
    ).toBe("/sales/vente-1?from=%2Fsales#debloquer");
  });

  it("paiement abouti : en attente, relit l'état, puis confirme une fois quand le serveur le dit", async () => {
    visit("?unlock_checkout=success&session_id=cs_1");
    const refetch = vi.fn().mockResolvedValue({ data: { unlocked: false } });
    const onConfirmed = vi.fn();
    const { result, rerender } = renderHook(
      ({ unlocked }) => useSalePurchaseReturn({ enabled: true, unlocked, refetch, onConfirmed }),
      { initialProps: { unlocked: false } },
    );

    expect(result.current).toBe("pending");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#debloquer");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SALE_PURCHASE_POLL_DELAYS_MS[0]);
    });
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(result.current).toBe("pending");
    expect(onConfirmed).not.toHaveBeenCalled();

    rerender({ unlocked: true });
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(result.current).toBeNull();
    rerender({ unlocked: true });
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it("jamais confirmé : quelques relectures espacées, puis `delayed`, sans confirmation", async () => {
    visit("?unlock_checkout=success");
    const refetch = vi.fn().mockResolvedValue({ data: { unlocked: false } });
    const onConfirmed = vi.fn();
    const { result } = renderHook(() =>
      useSalePurchaseReturn({ enabled: true, unlocked: false, refetch, onConfirmed }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(total);
    });
    expect(refetch).toHaveBeenCalledTimes(SALE_PURCHASE_POLL_DELAYS_MS.length);
    expect(result.current).toBe("delayed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(refetch).toHaveBeenCalledTimes(SALE_PURCHASE_POLL_DELAYS_MS.length);
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("une relecture en échec compte comme un essai, sans casser l'attente", async () => {
    visit("?unlock_checkout=success");
    const refetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("réseau"))
      .mockResolvedValue({ data: { unlocked: false } });
    const { result } = renderHook(() =>
      useSalePurchaseReturn({ enabled: true, unlocked: false, refetch, onConfirmed: vi.fn() }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SALE_PURCHASE_POLL_DELAYS_MS[0]);
    });
    expect(result.current).toBe("pending");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SALE_PURCHASE_POLL_DELAYS_MS[1]);
    });
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("annulation : aucun message, aucune relecture, l'adresse est nettoyée", async () => {
    visit("?unlock_checkout=cancelled");
    const refetch = vi.fn();
    const { result } = renderHook(() =>
      useSalePurchaseReturn({ enabled: true, unlocked: false, refetch, onConfirmed: vi.fn() }),
    );
    expect(result.current).toBeNull();
    expect(window.location.search).toBe("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(total);
    });
    expect(refetch).not.toHaveBeenCalled();
  });

  it("sans retour de paiement, ne relit rien", async () => {
    const refetch = vi.fn();
    const { result } = renderHook(() =>
      useSalePurchaseReturn({ enabled: true, unlocked: false, refetch, onConfirmed: vi.fn() }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(total);
    });
    expect(result.current).toBeNull();
    expect(refetch).not.toHaveBeenCalled();
  });
});
