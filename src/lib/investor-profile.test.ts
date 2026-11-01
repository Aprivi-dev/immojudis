import { describe, expect, it } from "vitest";
import {
  investorProfileFinancingDraft,
  investorProfileIsEmpty,
  investorProfileToChoices,
  parseProfileNumber,
  toInvestorProfile,
  type InvestorProfile,
} from "./investor-profile";
import { investorProfileInputSchema } from "./investor-profile-input";

const full: InvestorProfile = {
  downPaymentEur: 40_000,
  targetMarginPct: 15,
  worksPerM2Eur: 800,
  strategy: "revendre",
};

describe("toInvestorProfile", () => {
  it("garde les valeurs absentes comme absentes et écarte ce qui est invalide", () => {
    expect(
      toInvestorProfile({
        down_payment_eur: null,
        target_margin_pct: -3,
        works_per_m2_eur: 800,
        strategy: "habiter",
      }),
    ).toEqual({
      downPaymentEur: null,
      targetMarginPct: null,
      worksPerM2Eur: 800,
      strategy: null,
    });
  });
});

describe("investorProfileToChoices", () => {
  it("transforme la stratégie, la marge et les travaux au m² avec la surface de la vente", () => {
    expect(investorProfileToChoices(full, { surfaceM2: 50 })).toEqual({
      project: "revendre",
      customMarginPct: 15,
      works: { key: "devis", amount: 40_000 },
    });
  });

  it("ne multiplie jamais par une surface inconnue ou nulle", () => {
    for (const surfaceM2 of [null, undefined, 0, -5, Number.NaN]) {
      expect(investorProfileToChoices(full, { surfaceM2 }).works).toBeUndefined();
    }
    expect(investorProfileToChoices(full, { surfaceM2: null })).toEqual({
      project: "revendre",
      customMarginPct: 15,
    });
  });

  it("traduit des travaux à 0 €/m² en « aucun travaux »", () => {
    expect(
      investorProfileToChoices({ ...full, worksPerM2Eur: 0 }, { surfaceM2: 50 }).works,
    ).toEqual({ key: "aucun", amount: 0 });
  });

  it("n'écrit que ce que le profil contient, et rien sans profil", () => {
    expect(
      investorProfileToChoices(
        { downPaymentEur: 10_000, targetMarginPct: null, worksPerM2Eur: null, strategy: "louer" },
        { surfaceM2: 50 },
      ),
    ).toEqual({ project: "louer" });
    expect(investorProfileToChoices(null, { surfaceM2: 50 })).toEqual({});
  });
});

describe("investorProfileFinancingDraft", () => {
  it("préremplit seulement l'apport, quand il existe", () => {
    expect(investorProfileFinancingDraft(full)).toEqual({ downPayment: 40_000 });
    expect(investorProfileFinancingDraft({ ...full, downPaymentEur: null })).toBeNull();
    expect(investorProfileFinancingDraft({ ...full, downPaymentEur: 0 })).toBeNull();
    expect(investorProfileFinancingDraft(null)).toBeNull();
  });
});

describe("investorProfileIsEmpty", () => {
  it("est vrai sans profil ou sans aucune hypothèse", () => {
    expect(investorProfileIsEmpty(null)).toBe(true);
    expect(
      investorProfileIsEmpty({
        downPaymentEur: null,
        targetMarginPct: null,
        worksPerM2Eur: null,
        strategy: null,
      }),
    ).toBe(true);
    expect(investorProfileIsEmpty(full)).toBe(false);
  });
});

describe("parseProfileNumber", () => {
  const money = { max: 1_000_000, label: "Apport", decimals: false };
  const percent = { max: 50, label: "Marge cible", decimals: true };

  it("lit les séparateurs français et traite un champ vide comme une valeur absente", () => {
    expect(parseProfileNumber("40 000 €", money)).toEqual({ ok: true, value: 40_000 });
    expect(parseProfileNumber("12,5 %", percent)).toEqual({ ok: true, value: 12.5 });
    expect(parseProfileNumber("   ", money)).toEqual({ ok: true, value: null });
  });

  it("refuse le texte, les décimales d'un montant entier et le dépassement du maximum", () => {
    for (const raw of ["abc", "-4", "12,5"]) {
      expect(parseProfileNumber(raw, money).ok).toBe(false);
    }
    expect(parseProfileNumber("51", percent)).toEqual({
      ok: false,
      message: "Marge cible : le maximum est 50.",
    });
    expect(parseProfileNumber("185.000", percent).ok).toBe(false);
  });
});

describe("investorProfileInputSchema", () => {
  it("arrondit les montants et accepte des valeurs absentes", () => {
    expect(
      investorProfileInputSchema.parse({
        downPaymentEur: 40_000.4,
        targetMarginPct: 12.456,
        worksPerM2Eur: null,
        strategy: "louer",
      }),
    ).toEqual({
      downPaymentEur: 40_000,
      targetMarginPct: 12.46,
      worksPerM2Eur: null,
      strategy: "louer",
    });
  });

  it("refuse un profil vide, une stratégie inconnue, des bornes dépassées et des champs en trop", () => {
    for (const body of [
      {},
      { strategy: null, downPaymentEur: null },
      { strategy: "habiter" },
      { targetMarginPct: 51 },
      { targetMarginPct: -1 },
      { worksPerM2Eur: 10_001 },
      { downPaymentEur: -1 },
      { downPaymentEur: "40000" },
      { strategy: "louer", userId: "autre" },
    ]) {
      expect(investorProfileInputSchema.safeParse(body).success).toBe(false);
    }
  });
});
