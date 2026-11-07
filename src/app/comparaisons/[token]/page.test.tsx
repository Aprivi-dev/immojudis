import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ shared: vi.fn() }));

vi.mock("@/lib/sale-analysis-sets", () => ({ getSharedSaleComparison: mocks.shared }));
vi.mock("@/components/search/SaleComparisonTable", () => ({
  SaleComparisonTable: ({ items, returnTo }: { items: unknown[]; returnTo: string }) => (
    <div data-testid="table" data-return-to={returnTo}>
      {items.length}
    </div>
  ),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  },
}));

import Page from "./page";

function comparison(withdrawnCount: number) {
  return {
    name: "Ma sélection",
    items: [{ id: "a" }],
    withdrawnCount,
    sharedAt: "2026-10-01T10:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
  };
}

const render = async () =>
  renderToStaticMarkup(await Page({ params: Promise.resolve({ token: "t" }) }));

describe("shared comparison page", () => {
  beforeEach(() => vi.resetAllMocks());

  it("makes the shared comparison the origin of each sale sheet (« Retour à la comparaison »)", async () => {
    mocks.shared.mockResolvedValue(comparison(0));
    const token = "AbCdEfGhIjKlMnOpQrStUvWxYz012_-9";
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ token }) }));
    expect(html).toContain(`data-return-to="/comparaisons/${token}"`);
  });

  it("says nothing about withdrawn sales when none was withdrawn", async () => {
    mocks.shared.mockResolvedValue(comparison(0));

    const html = await render();

    expect(html).toContain('data-testid="table"');
    expect(html).not.toContain("retirée");
  });

  it("titles the page with the site's page title and eyebrow (repasse design n° 13)", async () => {
    mocks.shared.mockResolvedValue(comparison(0));

    const html = await render();

    expect(html).toMatch(/<h1 class="[^"]*text-\[2rem\][^"]*">Ma sélection<\/h1>/);
    expect(html).toMatch(/<p class="[^"]*text-gold-text[^"]*">Comparaison partagée Immojudis<\/p>/);
  });

  it("announces one withdrawn sale in the singular", async () => {
    mocks.shared.mockResolvedValue(comparison(1));

    expect(await render()).toContain("1 vente retirée du catalogue");
  });

  it("announces several withdrawn sales in the plural", async () => {
    mocks.shared.mockResolvedValue(comparison(3));

    expect(await render()).toContain("3 ventes retirées du catalogue");
  });

  it("answers 404 when the link is unknown or has no sale left", async () => {
    mocks.shared.mockRejectedValue(new Error("Comparaison partagée introuvable ou expirée."));

    await expect(render()).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });
});

describe("shared comparison link that no longer works (repasse design n° 29)", () => {
  it("explains that the link expired, was disabled or replaced, instead of the generic 404", async () => {
    const { default: SharedComparisonNotFound } = await import("./not-found");
    const html = renderToStaticMarkup(<SharedComparisonNotFound />);

    expect(html).toContain("Ce lien de comparaison n’est plus valable");
    expect(html).toMatch(/expiré, été désactivé ou remplacé/);
    expect(html).not.toContain("Page introuvable");
    expect(html).toMatch(/<a[^>]*href="\/sales"[^>]*>Voir les ventes<\/a>/);
  });
});
