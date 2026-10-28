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

describe("useSalePepiteState", () => {
  beforeEach(() => {
    mocks.ids.mockReset().mockResolvedValue(new Set());
    mocks.fetchPepite.mockReset().mockResolvedValue(PAYLOAD);
  });
  const useKnown = () =>
    useSalePepiteState({ saleId, view: "criteria", userKey: "public", known: true });

  it("passe de loading à ready", async () => {
    const { result } = renderHook(useKnown, { wrapper });
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.payload).toEqual(PAYLOAD);
  });

  it("dit error quand la route échoue (503, 429, réseau)", async () => {
    mocks.fetchPepite.mockRejectedValue(new Error("503"));
    const { result } = renderHook(useKnown, { wrapper });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.payload).toBeNull();
  });

  it("dit absent quand la route répond 404", async () => {
    mocks.fetchPepite.mockResolvedValue(null);
    const { result } = renderHook(useKnown, { wrapper });
    await waitFor(() => expect(result.current.status).toBe("absent"));
  });

  it("reste idle pour une vente qui n'est pas une pépite", async () => {
    const { result } = renderHook(
      () => useSalePepiteState({ saleId, view: "criteria", userKey: "u" }),
      { wrapper },
    );
    await waitFor(() => expect(mocks.ids).toHaveBeenCalled());
    expect(result.current.status).toBe("idle");
    expect(mocks.fetchPepite).not.toHaveBeenCalled();
  });
});
