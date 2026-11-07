// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  favorites: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.success } }));
vi.mock("@/lib/client-api", () => ({ fetchFavoriteSales: mocks.favorites }));

import { announceFavoriteAdded } from "./favorite-feedback";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderedDescription() {
  const [, options] = mocks.success.mock.calls[0] as [string, { description: ReactNode }];
  render(<>{options.description}</>);
}

describe("announceFavoriteAdded", () => {
  it("propose « Voir mes favoris » après l'ajout, puis l'alerte (repasse n° 27)", async () => {
    await announceFavoriteAdded(new QueryClient(), "user-1", null);
    expect(mocks.success).toHaveBeenCalledWith("Vente ajoutée aux favoris.", expect.anything());
    renderedDescription();
    const links = screen.getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Voir mes favoris", "/favoris"],
      ["Être prévenu des nouvelles ventes : créer une alerte", "/alertes"],
    ]);
  });

  it("garde le décompte des places sur une offre plafonnée", async () => {
    mocks.favorites.mockResolvedValue({ favorites: [{}, {}], unavailableSaleIds: ["x"] });
    await announceFavoriteAdded(new QueryClient(), "user-1", 10);
    expect(mocks.success.mock.calls[0][0]).toBe("Vente ajoutée aux favoris : 3 favoris sur 10.");
    renderedDescription();
    expect(screen.getByRole("link", { name: "Voir mes favoris" })).toBeTruthy();
  });
});
