// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ ids: vi.fn(), fetchPepite: vi.fn() }));
vi.mock("@/lib/search/pepite-filter", () => ({ fetchPepiteSaleIds: mocks.ids }));
vi.mock("@/lib/client-api/sale-pepite", () => ({ fetchSalePepite: mocks.fetchPepite }));

import { useSalePepite, useSalePepiteState } from "./use-sale-pepite";

const saleId = "11111111-1111-4111-8111-111111111111";
const PAYLOAD = { access: "criteria", count: 1, criteria: [] };

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useSalePepite", () => {
  beforeEach(() => {
    mocks.ids.mockReset().mockResolvedValue(new Set());
    mocks.fetchPepite.mockReset().mockResolvedValue(PAYLOAD);
  });

  it("n'appelle jamais la route quand la vente n'est pas dans la liste publique (mode shadow : liste vide)", async () => {
    const { result } = renderHook(() => useSalePepite({ saleId, view: "criteria", userKey: "u" }), {
      wrapper,
    });
    await waitFor(() => expect(mocks.ids).toHaveBeenCalled());
    expect(result.current).toBeNull();
    expect(mocks.fetchPepite).not.toHaveBeenCalled();
  });

  it("appelle la route d'une pépite connue de la liste, au niveau demandé", async () => {
    mocks.ids.mockResolvedValue(new Set([saleId]));
    const { result } = renderHook(() => useSalePepite({ saleId, view: "detail", userKey: "u" }), {
      wrapper,
    });
    await waitFor(() => expect(result.current).toEqual(PAYLOAD));
    expect(mocks.fetchPepite).toHaveBeenCalledWith(saleId, "detail");
  });

  it("une pépite déjà connue (aperçu public) n'a pas besoin de la liste", async () => {
    const { result } = renderHook(
      () => useSalePepite({ saleId, view: "criteria", userKey: "public", known: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current).toEqual(PAYLOAD));
    expect(mocks.ids).not.toHaveBeenCalled();
  });

  it("la fiche complète d'une pépite connue du serveur (known) ne relit pas la liste entière", async () => {
    const { result } = renderHook(
      () => useSalePepite({ saleId, view: "detail", userKey: "u", known: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current).toEqual(PAYLOAD));
    expect(mocks.ids).not.toHaveBeenCalled();
    expect(mocks.fetchPepite).toHaveBeenCalledWith(saleId, "detail");
  });

  it("signale la lecture en cours (place réservée) puis le résultat, ou l'absence de repère", async () => {
    const { result } = renderHook(
      () => useSalePepiteState({ saleId, view: "criteria", userKey: "public", known: true }),
      { wrapper },
    );
    expect(result.current).toEqual({ payload: null, pending: true });
    await waitFor(() => expect(result.current.payload).toEqual(PAYLOAD));
    expect(result.current.pending).toBe(false);

    mocks.fetchPepite.mockResolvedValue(null);
    const failed = renderHook(
      () => useSalePepiteState({ saleId, view: "criteria", userKey: "other", known: true }),
      { wrapper },
    );
    await waitFor(() => expect(failed.result.current.pending).toBe(false));
    expect(failed.result.current.payload).toBeNull();
  });

  it("rend null quand la route répond 404 ou échoue : le repère disparaît, la fiche ne change pas", async () => {
    mocks.fetchPepite.mockResolvedValue(null);
    const { result } = renderHook(
      () => useSalePepite({ saleId, view: "criteria", userKey: "u", known: true }),
      { wrapper },
    );
    await waitFor(() => expect(mocks.fetchPepite).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it("ne lit rien quand il est désactivé (annonce exemple)", async () => {
    renderHook(
      () => useSalePepite({ saleId, view: "criteria", userKey: "u", known: true, enabled: false }),
      { wrapper },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.fetchPepite).not.toHaveBeenCalled();
    expect(mocks.ids).not.toHaveBeenCalled();
  });
});
