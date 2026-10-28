import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Rendu serveur de l'accueil (renderToString) avec le VRAI fournisseur de l'état de l'essai.
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null, loading: false }) }));
vi.mock("@/hooks/use-analysis-checkout-open", () => ({ useAnalysisCheckoutOpen: () => false }));
vi.mock("@/lib/client-billing", () => ({ fetchLaunchOffer: vi.fn() }));

import { LaunchOfferProvider } from "@/components/LaunchOfferProvider";
import { HomeOffers } from "./HomeOffers";
import { HomePrimaryAction } from "./HomePrimaryAction";
import { HomeFaq, homeFaqItems } from "./HomeSections";

function textOf(markup: string): string {
  let text = "";
  let inTag = false;
  for (const char of markup) {
    if (char === "<") inTag = true;
    else if (char === ">") inTag = false;
    else if (!inTag) text += char;
  }
  return text.replaceAll("&#x27;", "’").replaceAll("&#39;", "’").replace(/\s+/g, " ");
}

function renderHome(trialOpen: boolean | undefined) {
  return textOf(
    renderToString(
      <LaunchOfferProvider initialActive={trialOpen}>
        <HomePrimaryAction />
        <HomeOffers />
        <HomeFaq trialOpen={trialOpen} />
      </LaunchOfferProvider>,
    ),
  );
}

describe("accueil : l'essai au rendu serveur", () => {
  it("essai ouvert : l'écran, les offres et la FAQ annoncent l'essai de 7 jours", () => {
    const text = renderHome(true);
    expect(text).toContain("7 jours d’accès à l’offre Analyse, sans carte bancaire.");
    expect(text).toContain("Explorez gratuitement. Analysez 7 jours sans payer.");
    expect(text).toContain("Et après les 7 jours d’essai ?");
    expect(text).toContain("Quand commence l’essai ?");
  });

  it("essai fermé, lu : ni l'écran, ni les offres, ni la FAQ n'annoncent d'essai", () => {
    const text = renderHome(false);
    expect(text).not.toContain("jours d’accès complet");
    expect(text).toContain("Explorez gratuitement. Analysez en profondeur.");
    expect(text).not.toMatch(/jours d’essai|Quand commence l’essai|Et après l’essai/);
    expect(text).toContain("Combien coûte l’inscription ?");
  });

  it("essai non lu : des questions vraies dans les deux états, sans promesse d'essai ouvert", () => {
    const text = renderHome(undefined);
    expect(text).toContain("Et après l’essai gratuit ?");
    expect(text).toContain("Quand l’essai est ouvert à l’inscription, il commence");
    expect(text).not.toContain("jours d’accès complet");
  });
});

describe("accueil : questions et données structurées (FAQPage) suivent l'état de l'essai", () => {
  const questions = (trialOpen?: boolean) =>
    homeFaqItems({ trialOpen }).map((item) => item.question);

  it("retire les deux questions sur l'essai quand il est fermé", () => {
    expect(questions(false)).not.toContain("Quand commence l’essai ?");
    expect(questions(false).some((question) => question.includes("essai"))).toBe(false);
  });

  it("les garde quand il est ouvert, et en version neutre quand l'état n'est pas lu", () => {
    expect(questions(true)).toContain("Quand commence l’essai ?");
    expect(questions(undefined)).toContain("Quand commence l’essai gratuit ?");
    expect(questions(undefined)).not.toContain("Quand commence l’essai ?");
    expect(questions(true)).toHaveLength(questions(undefined).length);
    expect(questions(false)).toHaveLength(questions(true).length - 2);
  });

  it("ne contient jamais de prix", () => {
    for (const trialOpen of [true, false, undefined]) {
      const all = homeFaqItems({ trialOpen })
        .map((item) => `${item.question} ${item.answer}`)
        .join(" ");
      expect(all).not.toMatch(/€|59/);
    }
  });
});
