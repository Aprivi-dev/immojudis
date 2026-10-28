// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import {
  pepiteCriteriaPayload,
  pepiteCriteriaViews,
  pepiteDetailPayload,
  pepiteDetailView,
  pepiteFloodView,
  type PepitePayload,
} from "@/lib/sale-pepite-view";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth() }));
vi.mock("@/lib/client-api-core", () => ({ authHeaders: vi.fn() }));

import { PepiteBlock, pepiteTitle } from "./PepiteBlock";

const saleId = "11111111-1111-4111-8111-111111111111";

const CRITERIA = pepiteCriteriaViews(
  [
    "pass:regime_open",
    "pass:sale_upcoming",
    "pass:estimate_actionable",
    "pass:test_c_cost",
    "fail:test_b_chance",
  ],
  [],
  "tribunal",
);

const DETAILS = {
  regime: "tribunal",
  referenceCeilingEur: 118_000,
  probablePriceEur: 90_000,
  rangeLowEur: 75_000,
  rangeHighEur: 110_000,
  costRatio: 0.68,
  chanceShare: 0.78,
  multiplierKey: "q50",
  scenarios: { reliability: "good", courtSample: 40, nationalSample: 800 },
};

const PASSING = pepiteCriteriaViews(
  ["pass:regime_open", "pass:test_c_cost", "pass:test_b_chance"],
  [],
  "tribunal",
);

const locked: PepitePayload = pepiteCriteriaPayload(CRITERIA);
const open: PepitePayload = pepiteDetailPayload(
  PASSING,
  pepiteDetailView(DETAILS, "2026-11-05T09:00:00.000Z", PASSING)!,
);
// Un critère à confirmer : la condition parle du seuil de maintien, pas du seuil d'entrée.
const openConfirm: PepitePayload = pepiteDetailPayload(
  CRITERIA,
  pepiteDetailView(DETAILS, "2026-11-05T09:00:00.000Z", CRITERIA)!,
);

describe("PepiteBlock", () => {
  beforeEach(() => mocks.auth.mockReturnValue({ user: { id: "user-1" }, loading: false }));
  afterEach(cleanup);

  it("ne rend rien sans réponse (pas une pépite, mode shadow, panne)", () => {
    const { container } = render(<PepiteBlock payload={null} saleId={saleId} />);
    expect(container.innerHTML).toBe("");
  });

  describe("version verrouillée (visiteur, compte Découverte non débloqué)", () => {
    it("annonce les deux critères en tête, avec leur état en texte et en icône, et replie les vérifications", () => {
      render(<PepiteBlock payload={locked} saleId={saleId} />);
      // Un critère rempli (coût d'achat sous la valeur), un à confirmer (chances de l'emporter).
      const section = screen.getByRole("region", {
        name: "Pépite : 1 critère rempli sur 2, 1 à confirmer",
      });
      expect(section.id).toBe("pepite");
      expect(section.textContent).not.toMatch(/critères réunis/);
      const tests = within(
        screen.getByRole("list", { name: "Critères de la pépite" }),
      ).getAllByRole("listitem");
      expect(tests).toHaveLength(2);
      // Réussi : icône + texte pour lecteur d'écran ; à confirmer : icône + texte visible.
      const done = tests.find((item) => item.textContent?.includes("Coût d'achat estimé"))!;
      expect(done.textContent).toContain("Rempli");
      expect(done.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      const toConfirm = tests.find((item) => item.textContent?.includes("Chances de l'emporter"))!;
      expect(toConfirm.textContent).toContain("À confirmer");
      expect(toConfirm.textContent).toContain("seuil de maintien");
      expect(toConfirm.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

      // Le reste tient en une ligne dépliable.
      const summary = screen.getByText("Vérifications de fiabilité remplies (3 sur 3)");
      const details = summary.closest("details")!;
      expect(details.open).toBe(false);
      expect(within(details).getAllByRole("listitem")).toHaveLength(3);
      expect(details.textContent).toContain("Type de vente pris en compte");
      expect(section.textContent).not.toMatch(/Test [BC]|P10|effectif|porte publique|\bIA\b/);
    });

    it("sans aucun critère rempli, le titre le dit au lieu de compter à zéro", () => {
      render(
        <PepiteBlock
          payload={pepiteCriteriaPayload(
            pepiteCriteriaViews(["fail:test_b_chance", "fail:test_c_cost"], [], "tribunal"),
          )}
          saleId={saleId}
        />,
      );
      expect(screen.getByRole("region", { name: "Pépite : critères à confirmer" })).toBeTruthy();
    });

    it("n'affiche aucun montant, aucune valeur, et aucun flou CSS", () => {
      const { container } = render(<PepiteBlock payload={locked} saleId={saleId} />);
      expect(container.textContent).not.toMatch(/€|\b\d{2,3}[\s\u00a0\u202f]\d{3}\b/);
      expect(container.textContent).not.toMatch(
        /Prix de référence|fourchette|Voir avec mes hypothèses/,
      );
      expect(container.innerHTML).not.toMatch(/blur|filter|backdrop/);
      expect(screen.queryByText(/Utile/)).toBeNull();
    });

    it("pose la ligne avec cadenas qui renvoie au déblocage, et la mention de la méthode", () => {
      render(
        <PepiteBlock
          payload={locked}
          saleId={saleId}
          lockedAction={<a href="#debloquer">Débloquer cette vente (il vous reste 3 sur 3)</a>}
        />,
      );
      expect(screen.getByText("Montant et détail : débloquez cette vente")).toBeTruthy();
      expect(screen.getByRole("link", { name: /Débloquer cette vente/ })).toBeTruthy();
      expect(document.body.textContent).toContain(
        "Ce n'est ni un conseil, ni une recommandation d'acheter, ni une garantie de prix.",
      );
      expect(
        screen
          .getByRole("link", { name: "Comment repérons-nous les pépites ?" })
          .getAttribute("href"),
      ).toBe("/methode-pepites");
    });

    it("propose « Créez un compte gratuit » à un visiteur", () => {
      render(
        <PepiteBlock
          payload={locked}
          saleId={saleId}
          lockedAction={<a href="/login?mode=investor">Créez un compte gratuit</a>}
        />,
      );
      expect(screen.getByRole("link", { name: "Créez un compte gratuit" })).toBeTruthy();
    });

    it("n'a pas de défaut d'accessibilité", async () => {
      const { container } = render(
        <main>
          <PepiteBlock payload={locked} saleId={saleId} />
        </main>,
      );
      expect((await axe(container)).violations).toEqual([]);
    });
  });

  describe("version ouverte (Analyse, vente débloquée)", () => {
    it("écrit la condition, le plafond de référence, le prix de référence et sa réserve", () => {
      render(<PepiteBlock payload={open} saleId={saleId} />);
      const text = document.body.textContent ?? "";
      expect(text).toContain(
        "Sur les ventes comparables passées du tribunal, complétées par la tendance nationale, 78 % ont été adjugées sous l'enchère plafond estimée. Le critère est rempli à partir de 70 %.",
      );
      expect(text).toMatch(/Enchère plafond estimée : 118\s000\s€ \(hypothèses par défaut/u);
      expect(text).toMatch(
        /Prix de référence : environ 90\s000\s€ \(fourchette 75\s000\s€ – 110\s000\s€\)/u,
      );
      expect(text).toContain(
        "Repère statistique tiré de 40 ventes comparables passées du tribunal",
      );
      expect(text).toContain(
        "Ce n'est pas une prévision du prix final : les enchères peuvent dépasser ce montant.",
      );
      expect(text).toContain("Calcul automatique du ");
      expect(text).toContain("Ni conseil, ni recommandation d'acheter, ni garantie.");
      expect(screen.queryByText("Montant et détail : débloquez cette vente")).toBeNull();
      expect(
        screen.getByRole("link", { name: "Voir avec mes hypothèses" }).getAttribute("href"),
      ).toBe("#calculation");
    });

    it("énonce le seuil de maintien à côté du seuil d'entrée quand un critère est à confirmer", () => {
      render(<PepiteBlock payload={openConfirm} saleId={saleId} />);
      const text = document.body.textContent ?? "";
      expect(text).toContain("Le critère est rempli à partir de 70 % ;");
      expect(text).toContain("la mention est maintenue jusqu'à 65 %");
    });

    it("montre les deux plafonds quand celui de l'utilisateur diffère", () => {
      render(<PepiteBlock payload={open} saleId={saleId} userCeilingEur={131_000} />);
      expect(document.body.textContent).toMatch(
        /Votre plafond : 131\s000\s€ · Plafond de référence de la pépite : 118\s000\s€/u,
      );
    });

    it("n'ajoute rien quand les deux plafonds sont égaux ou que celui de l'utilisateur manque", () => {
      const { rerender } = render(
        <PepiteBlock payload={open} saleId={saleId} userCeilingEur={118_000} />,
      );
      expect(document.body.textContent).not.toContain("Votre plafond");
      rerender(<PepiteBlock payload={open} saleId={saleId} userCeilingEur={null} />);
      expect(document.body.textContent).not.toContain("Votre plafond");
    });

    it("affiche le retour « Utile / Pas pertinent » seulement ici", () => {
      render(<PepiteBlock payload={open} saleId={saleId} />);
      expect(screen.getByRole("button", { name: "Utile" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Pas pertinent" })).toBeTruthy();
    });

    it("vente interactive : « offre plafond » et prix de réserve inconnu, pas de prix de référence", () => {
      const interactive = pepiteDetailPayload(
        CRITERIA,
        pepiteDetailView(
          {
            regime: "notary_online",
            startingPriceEur: 40_000,
            referenceCeilingEur: 70_000,
            costRatio: 0.6,
          },
          null,
        )!,
      );
      render(<PepiteBlock payload={interactive} saleId={saleId} />);
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/Offre plafond estimée : 70\s000\s€/u);
      expect(text).toContain("Première offre possible : 40");
      expect(text).toContain("Prix de réserve du vendeur inconnu");
      expect(text).not.toContain("Prix de référence");
    });

    it("n'a pas de défaut d'accessibilité", async () => {
      const { container } = render(
        <main>
          <PepiteBlock payload={open} saleId={saleId} userCeilingEur={131_000} />
        </main>,
      );
      expect((await axe(container)).violations).toEqual([]);
    });
  });
});

describe("PepiteBlock : contrôle du risque d'inondation (règle v2)", () => {
  beforeEach(() => mocks.auth.mockReturnValue({ user: { id: "user-1" }, loading: false }));
  afterEach(cleanup);

  const withFlood = (verdict: string, observedAt: string | null = "2026-11-05T09:00:00.000Z") =>
    pepiteCriteriaPayload(PASSING, pepiteFloodView({ flood: { verdict, observedAt } }));

  it("hors des zones testées : phrase factuelle, icône neutre sans coche, source avec lien, cartes consultées repliées, mise en garde", () => {
    render(<PepiteBlock payload={withFlood("none_found")} saleId={saleId} />);
    const row = screen.getByRole("group", { name: "Risque d’inondation" });
    expect(row.textContent).toContain("Bien non situé dans la zone de crue fréquente");
    expect(row.textContent).not.toContain("Aucun risque d’inondation");
    expect(within(row).queryByText("Réussi :", { exact: false })).toBeNull();
    expect(within(row).getByText("Information :", { exact: false })).toBeTruthy();
    expect(row.textContent).toContain("Un plan de prévention seulement prescrit n’apparaît pas");
    const link = within(row).getByRole("link", { name: /Source : Géorisques/ });
    expect(link.getAttribute("href")).toBe("https://www.georisques.gouv.fr/");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(row.querySelector("details summary")?.textContent).toBe("Cartes consultées");
    expect(document.body.textContent).toContain(
      "Contrôle automatique d’après des cartes officielles",
    );
  });

  it("exposé : pictogramme d'alerte (jamais de coche), mention courte et développée, au niveau gratuit", () => {
    render(<PepiteBlock payload={withFlood("exposed")} saleId={saleId} />);
    const row = screen.getByRole("group", { name: "Risque d’inondation" });
    expect(row.textContent).toContain(
      "Dans le périmètre d’un plan de prévention des risques d’inondation (PPRi) : zonage à vérifier.",
    );
    expect(row.textContent).toContain("Ce périmètre ne dit pas dans quelle zone du plan");
    expect(within(row).queryByText("Réussi :", { exact: false })).toBeNull();
    expect(within(row).getByText("Attention :", { exact: false })).toBeTruthy();
    expect(within(row).getByRole("link", { name: /Géoportail de l’urbanisme/ })).toBeTruthy();
  });

  it.each(["no_signal", "unknown"])("%s : ligne neutre, jamais de coche", (verdict) => {
    render(<PepiteBlock payload={withFlood(verdict)} saleId={saleId} />);
    const row = screen.getByRole("group", { name: "Risque d’inondation" });
    expect(within(row).queryByText("Réussi :", { exact: false })).toBeNull();
    expect(within(row).getByText("Information :", { exact: false })).toBeTruthy();
    expect(within(row).queryByRole("link")).toBeNull();
  });

  it("sans contrôle (règle v1) : ni ligne ni mise en garde", () => {
    render(<PepiteBlock payload={pepiteCriteriaPayload(PASSING)} saleId={saleId} />);
    expect(screen.queryByRole("group", { name: "Risque d’inondation" })).toBeNull();
    expect(document.body.textContent).not.toContain("Contrôle automatique");
  });

  it("n'a pas de défaut d'accessibilité", async () => {
    const { container } = render(
      <main>
        <PepiteBlock payload={withFlood("exposed")} saleId={saleId} />
      </main>,
    );
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe("pepiteTitle", () => {
  it.each([
    [2, 2, "Pépite : 2 critères remplis sur 2"],
    [1, 2, "Pépite : 1 critère rempli sur 2, 1 à confirmer"],
    [0, 2, "Pépite : critères à confirmer"],
    [1, 1, "Pépite : critère rempli"],
    [0, 1, "Pépite : critère à confirmer"],
    [0, 0, "Pépite : critère à confirmer"],
  ])("%i rempli(s) sur %i", (filled, total, expected) => {
    expect(pepiteTitle(filled, total)).toBe(expected);
  });

  it("en vente notariale, un seul critère s'applique : pas de « 1 sur 1 »", () => {
    const notarial = pepiteCriteriaPayload(
      pepiteCriteriaViews(["pass:test_c_cost"], [], "notary_auction"),
    );
    render(<PepiteBlock payload={notarial} saleId={saleId} />);
    expect(screen.getByRole("region", { name: "Pépite : critère rempli" })).toBeTruthy();
    cleanup();
  });
});
