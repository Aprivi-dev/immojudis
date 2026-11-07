// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  track: vi.fn(),
  auth: { user: null as null | { id: string }, loading: false },
  launch: { active: false, pending: false },
}));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/hooks/use-launch-offer", () => ({ useLaunchOffer: () => mocks.launch }));
vi.mock("@/components/SimplifiedSaleDetailView", () => ({
  AnalysisSaleDetailView: ({
    sale,
    marketEstimateOverride,
    publicDemo,
    returnTo,
    adjudicationStatisticsEnabled,
    summaryFooter,
    topNotice,
  }: {
    sale: { city: string; title: string };
    marketEstimateOverride: { actionable?: boolean };
    publicDemo?: boolean;
    returnTo?: string;
    adjudicationStatisticsEnabled?: boolean;
    summaryFooter?: ReactNode;
    topNotice?: ReactNode;
  }) => (
    <div
      data-testid="example-detail"
      data-city={sale.city}
      data-access={publicDemo ? "public-analysis" : "restricted"}
      data-market={marketEstimateOverride.actionable ? "complete" : "missing"}
      data-return-to={returnTo}
      data-statistics={adjudicationStatisticsEnabled ? "open" : "closed"}
    >
      {topNotice}
      {sale.title}
      {summaryFooter}
    </div>
  ),
}));

import { getExampleSaleRecords } from "@/lib/example-sale";
import { ExampleSalePage } from "./example-sale-page";

describe("ExampleSalePage", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.launch = { active: false, pending: false };
  });

  it("finit sur un compte gratuit et le catalogue, jamais sur /offres (non souscriptible)", () => {
    mocks.auth = { user: null, loading: false };
    render(<ExampleSalePage example={getExampleSaleRecords().bordeaux} />);
    const block = screen.getByTestId("example-next-steps");
    const hrefs = Array.from(block.querySelectorAll("a")).map((link) => [
      link.textContent,
      link.getAttribute("href"),
    ]);
    expect(hrefs).toEqual([
      ["Créer mon compte gratuit", "/login?redirect=%2Fsales&mode=investor&reason=exemple"],
      ["Explorer les ventes", "/sales"],
    ]);
    expect(block.innerHTML).not.toContain("/offres");
    expect(block.textContent).not.toMatch(/offre Analyse|abonn|€/i);
  });

  it("rappelle le calcul sur les ventes réelles : 3 par mois sans l'essai", () => {
    mocks.auth = { user: null, loading: false };
    render(<ExampleSalePage example={getExampleSaleRecords().bordeaux} />);
    expect(screen.getByTestId("example-next-steps").textContent).toContain(
      "Avec un compte gratuit, ce calcul sur 3 ventes réelles par mois. Sans carte bancaire.",
    );
  });

  it("essai ouvert : toutes les ventes qui ont un plafond pendant 7 jours, puis 3 par mois", () => {
    mocks.auth = { user: null, loading: false };
    mocks.launch = { active: true, pending: false };
    const { unmount } = render(<ExampleSalePage example={getExampleSaleRecords().bordeaux} />);
    expect(screen.getByTestId("example-next-steps").textContent).toContain(
      "Avec un compte gratuit, ce calcul sur les ventes réelles (ventes au tribunal, ventes notariales à la bougie et ventes notariales interactives) : sur toutes pendant 7 jours, puis sur 3 par mois. Sans carte bancaire.",
    );
    unmount();
    // Seul le tribunal ouvert : la phrase ne promet pas le calcul aux ventes notariales.
    render(
      <ExampleSalePage example={getExampleSaleRecords().bordeaux} openFeeRegimes={["tribunal"]} />,
    );
    const block = screen.getByTestId("example-next-steps");
    expect(block.textContent).toContain(
      "Avec un compte gratuit, ce calcul sur les ventes réelles (ventes au tribunal) : sur toutes pendant 7 jours, puis sur 3 par mois. Sans carte bancaire.",
    );
    expect(block.textContent).not.toContain("notariales");
  });

  it("propose l'inscription dès la synthèse, avec la phrase de l'accueil", () => {
    mocks.auth = { user: null, loading: false };
    render(<ExampleSalePage example={getExampleSaleRecords().bordeaux} />);
    const cta = screen.getByTestId("example-summary-cta");
    const link = cta.querySelector("a");
    expect(link?.textContent).toBe("Créer mon compte gratuit");
    expect(link?.getAttribute("href")).toBe(
      "/login?redirect=%2Fsales&mode=investor&reason=exemple",
    );
    // Sans offre d'essai lue (aucun fournisseur) : la ligne du compte gratuit.
    expect(cta.textContent).toContain("Gratuit, sans carte bancaire");
    // La synthèse est dans la vue de l'exemple, avant le bloc de fin de page.
    expect(screen.getByTestId("example-detail").contains(cta)).toBe(true);
  });

  it("propose aussi d'être prévenu des ventes de son département, case non cochée", async () => {
    mocks.auth = { user: null, loading: false };
    render(<ExampleSalePage example={getExampleSaleRecords().bordeaux} />);
    expect(
      await screen.findByRole(
        "heading",
        { name: "Être prévenu des ventes de mon département" },
        { timeout: 10_000 },
      ),
    ).toBeTruthy();
    expect(document.body.textContent).toContain("L’email récapitulatif est facultatif");
    expect(screen.queryByRole("checkbox")).toBeNull();
    // Le bloc de fin garde ses deux liens : la proposition d'alerte est à part.
    const block = screen.getByTestId("example-next-steps");
    expect(block.textContent).not.toContain("Être prévenu");
  });

  it("ne propose plus de créer un compte à une personne connectée", () => {
    mocks.auth = { user: { id: "user-1" }, loading: false };
    render(<ExampleSalePage example={getExampleSaleRecords().bordeaux} />);
    const block = screen.getByTestId("example-next-steps");
    expect(block.textContent).not.toContain("Créer mon compte gratuit");
    expect(block.querySelector('a[href="/sales"]')).not.toBeNull();
    expect(screen.queryByTestId("example-summary-cta")).toBeNull();
    mocks.auth = { user: null, loading: false };
  });

  it("mesure la consultation de l'annonce exemple, sans identifiant de vente", () => {
    render(<ExampleSalePage example={getExampleSaleRecords().bordeaux} />);
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith("sample_report_viewed");
  });

  it("prépare la connexion à Mapbox pour l'image d'attente de la vue aérienne", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/app/annonce-exemple/example-sale-page.tsx", "utf8");
    expect(source).toContain("<MapboxPreconnect />");
  });

  it("transmet le drapeau des statistiques à la vue, fermé par défaut", async () => {
    const { unmount } = render(<ExampleSalePage example={getExampleSaleRecords().bordeaux} />);
    expect((await screen.findByTestId("example-detail")).dataset.statistics).toBe("closed");
    unmount();
    render(
      <ExampleSalePage example={getExampleSaleRecords().bordeaux} adjudicationStatisticsEnabled />,
    );
    expect((await screen.findByTestId("example-detail")).dataset.statistics).toBe("open");
  });

  it.each([
    ["bordeaux", "Bordeaux"],
    ["nantes", "Nantes"],
    ["toulouse", "Toulouse"],
  ] as const)("rend l'exemple %s avec l'analyse publique complète", async (bien, city) => {
    render(<ExampleSalePage example={getExampleSaleRecords()[bien]} />);

    const detail = await screen.findByTestId("example-detail");
    expect(detail.dataset.city).toBe(city);
    expect(detail.dataset.access).toBe("public-analysis");
    expect(detail.dataset.market).toBe("complete");
    // L'ancre existe sur l'accueil (`id="essayer"`) ; « #exemples » n'a jamais existé.
    expect(detail.dataset.returnTo).toBe("/#essayer");
  });

  it("annonce clairement que l'exemple est fictif, avant tout chiffre", () => {
    render(<ExampleSalePage example={getExampleSaleRecords().bordeaux} />);
    const banner = screen.getByRole("complementary", { name: "Exemple fictif" });
    expect(banner.textContent).toMatch(/Exemple fictif/);
    expect(banner.textContent).toMatch(/Aucune vente réelle/);
    // En tête du contenu de la fiche (sous la pilule de navigation, pas derrière elle : repasse
    // n° 3), avant le titre de la vente.
    const detail = screen.getByTestId("example-detail");
    expect(detail.firstElementChild).toBe(banner);
    // Jetons `warning` de la charte, plus aucune couleur ambre brute.
    expect(banner.innerHTML).toContain("bg-warning-tint");
    expect(banner.innerHTML).not.toMatch(/amber-/);
  });

  it("ne contient pas de lien externe ni de données structurées d'annonce", () => {
    const { container } = render(<ExampleSalePage example={getExampleSaleRecords().bordeaux} />);
    expect(container.querySelector('script[type="application/ld+json"]')).toBeNull();
  });
});
