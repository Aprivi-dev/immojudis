// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  error: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  announce: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast: { error: mocks.error } }));
vi.mock("@/lib/client-api", () => ({
  addFavoriteSale: mocks.add,
  removeFavoriteSale: mocks.remove,
}));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: vi.fn() }));
vi.mock("@/components/favorite-feedback", () => ({ announceFavoriteAdded: mocks.announce }));

import { toggleFavoriteSale } from "./favorite-removal";

afterEach(() => vi.clearAllMocks());

describe("toggleFavoriteSale", () => {
  const searchKey = ["search-favorite-status", "user-1"];
  const run = (queryClient: QueryClient, favorite: boolean, confirm = true) => {
    const onToggled = vi.fn();
    const done = toggleFavoriteSale({
      queryClient,
      userId: "user-1",
      saleId: "s2",
      favorite,
      confirmRemoval: async () => confirm,
      onToggled,
    });
    return { done, onToggled };
  };

  it("ajoute la vente, l'annonce et la met dans la liste des favoris de la recherche", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData([...searchKey, "ids"], ["s1"]);
    mocks.add.mockResolvedValue({ plan: { limit: null } });
    const { done, onToggled } = run(queryClient, false);
    await done;
    expect(mocks.add).toHaveBeenCalledWith({ data: { saleId: "s2" } });
    expect(onToggled).toHaveBeenCalledWith(true, null);
    expect(mocks.announce).toHaveBeenCalledWith(queryClient, "user-1", null);
    expect(queryClient.getQueryData([...searchKey, "ids"])).toEqual(["s1", "s2"]);
  });

  it("retire la vente et rend le dossier emporté ; un retrait refusé ne change rien", async () => {
    const queryClient = new QueryClient();
    const dossier = { personalStatus: "interested", bidCeilingEur: 90_000 };
    mocks.remove.mockResolvedValue({ dossier });
    const removal = run(queryClient, true);
    await removal.done;
    expect(removal.onToggled).toHaveBeenCalledWith(false, dossier);

    mocks.remove.mockClear();
    const refused = run(queryClient, true, false);
    await refused.done;
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(refused.onToggled).not.toHaveBeenCalled();
  });

  it("dit un échec sans changer l'état affiché", async () => {
    mocks.add.mockRejectedValue(new Error("Vous avez atteint la limite de favoris."));
    const { done, onToggled } = run(new QueryClient(), false);
    await done;
    expect(onToggled).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith("Vous avez atteint la limite de favoris.");
  });
});
