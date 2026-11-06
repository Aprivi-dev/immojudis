// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FavoriteSale } from "@/lib/favorites";
import type { DescribedSaleChange } from "@/lib/sale-change-display";
import { FollowedSalesSummary } from "./FollowedSalesSummary";
import type { FollowedSales } from "./use-followed-sales";

afterEach(cleanup);

const favorite = (saleId: string, sale: Record<string, unknown> = {}) =>
  ({
    id: `fav-${saleId}`,
    saleId,
    favoritedAt: "2026-10-01T10:00:00Z",
    personalStatus: null,
    bidCeilingEur: null,
    bidCeilingSavedAt: null,
    sale: { id: saleId, city: "Lyon", sale_date: "2026-11-20T09:00:00Z", ...sale },
  }) as unknown as FavoriteSale;

function followed(overrides: Partial<FollowedSales> = {}): FollowedSales {
  return {
    favorites: null,
    todaySales: [],
    dossierBySaleId: new Map(),
    changes: null,
    lastChangeBySaleId: new Map(),
    alertNews: null,
    ...overrides,
  };
}

const caseTexts = () =>
  within(screen.getByRole("navigation", { name: "Votre suivi" }))
    .getAllByRole("link")
    .map((link) => [link.getAttribute("href"), link.textContent]);

describe("FollowedSalesSummary", () => {
  it("n'affiche rien tant qu'aucune donnée n'est lue : jamais de chiffre de remplacement", () => {
    const { container } = render(<FollowedSalesSummary followed={followed()} />);
    expect(container.innerHTML).toBe("");
  });

  it("donne une case par donnée connue, chacune un lien", () => {
    const paris = favorite("sale-paris", {
      city: "Paris 8e",
      sale_date: "2026-11-06T11:00:00Z",
    });
    render(
      <FollowedSalesSummary
        followed={followed({
          favorites: [paris, favorite("b"), favorite("c")],
          todaySales: [paris],
          changes: [{} as DescribedSaleChange, {} as DescribedSaleChange],
          alertNews: { saleCount: 5, alertCount: 2, capped: false },
        })}
      />,
    );
    expect(caseTexts()).toEqual([
      ["/favoris", "3ventes suiviesventes suivies"],
      ["/sales/sale-paris", "1aujourd’hui, 12 h 00vente suivie aujourd’hui · Paris 8e, 12 h 00"],
      ["/favoris#favorite-changes-title", "2changementschangements récents sur vos ventes suivies"],
      ["/alertes", "5nouvelles ventesnouvelles ventes dans vos 2 alertes"],
    ]);
  });

  it("n'affiche pas la case du jour sans vente suivie aujourd'hui, et dit « 12+ » au plafond de lecture", () => {
    render(
      <FollowedSalesSummary
        followed={followed({
          favorites: [favorite("a")],
          alertNews: { saleCount: 12, alertCount: 1, capped: true },
        })}
      />,
    );
    expect(caseTexts()).toEqual([
      ["/favoris", "1vente suivievente suivie"],
      ["/alertes", "12+nouvelles ventesnouvelles ventes dans votre alerte"],
    ]);
  });

  it("garde des cibles de 44 px et une rangée qui défile sur mobile", () => {
    render(<FollowedSalesSummary followed={followed({ favorites: [] })} />);
    const nav = screen.getByRole("navigation", { name: "Votre suivi" });
    expect(nav.className).toContain("overflow-x-auto");
    expect(nav.className).toContain("sm:grid");
    expect(within(nav).getByRole("link").className).toContain("min-h-11");
  });
});
