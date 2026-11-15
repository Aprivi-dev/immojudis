import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SALE_UNLOCK_PURCHASE_REFUSAL_CODES } from "@/lib/sale-unlock-checkout-contract";
import { unlockCreditsLine, unlockSourceLabel } from "@/lib/sale-unlocks";
import {
  SALE_UNLOCK_CHECKOUT_CONFLICT_TEXTS,
  saleUnlockPurchaseChoiceTexts,
} from "@/lib/sale-unlock-purchase-texts";
import {
  formatEuroCents,
  salePurchaseOfferLine,
  salePurchaseOffersNote,
  subscriptionCheaperFrom,
} from "@/lib/sale-unlock-offer-texts";

const plain = (text: string | null) => text?.replace(/[\u00a0\u202f]/g, " ") ?? null;

describe("achat d'une vente à l'unité : textes", () => {
  it("écrit les montants en euros, sans centimes quand il n'y en a pas", () => {
    expect(plain(formatEuroCents(1900))).toBe("19 €");
    expect(plain(formatEuroCents(4050))).toBe("40,50 €");
    expect(plain(formatEuroCents(0))).toBe("0 €");
  });

  it("calcule à partir de combien de ventes l'abonnement revient strictement moins cher", () => {
    const from = (unitCents: number, subscriptionCents: number | null) =>
      subscriptionCheaperFrom({ unitCents, subscriptionCents });
    expect(from(1900, 5900)).toBe(4);
    expect(from(2000, 6000)).toBe(4);
    expect(from(3000, 5900)).toBe(2);
    for (const unit of [0, -1900, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(from(unit, 5900)).toBeNull();
    }
    expect(from(1900, null)).toBeNull();
    expect(from(1900, 0)).toBeNull();
  });

  it("n'affiche jamais une phrase que l'arithmétique des prix contredit", () => {
    const words = ["deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix"];
    for (const unitCents of [500, 999, 1200, 1900, 2000, 2500, 3000, 5900, 7000]) {
      for (const subscriptionCents of [2900, 5900, 6000, 9900]) {
        const sentence = saleUnlockPurchaseChoiceTexts({
          unit: { label: "x", amountCents: unitCents },
          subscriptionLabel: "x",
          subscriptionCents,
          firstMonthDeductionCents: 0,
        }).subscriptionText;
        const match = /À partir (?:d’une vente|de (\S+) ventes) à l’unité/.exec(sentence);
        expect(match, sentence).not.toBeNull();
        const word = match![1];
        const count =
          word == null ? 1 : words.includes(word) ? words.indexOf(word) + 2 : Number(word);
        // Le total de `count` ventes dépasse le mois ; celui de `count - 1` ne le dépasse pas.
        expect(count * unitCents, sentence).toBeGreaterThan(subscriptionCents);
        expect((count - 1) * unitCents, sentence).toBeLessThanOrEqual(subscriptionCents);
        const note = salePurchaseOffersNote({ unitCents, subscriptionCents });
        expect(note).toContain(sentence.replace("Sans engagement. ", "").replace(" à l’unité", ""));
      }
    }
  });

  it("compose les deux choix à partir des montants reçus, jamais écrits à la main", () => {
    const texts = saleUnlockPurchaseChoiceTexts({
      unit: { label: "19 €", amountCents: 1900 },
      subscriptionLabel: "59 € TTC / mois",
      subscriptionCents: 5900,
      firstMonthDeductionCents: 0,
    });
    expect(plain(texts.subscriptionTitle)).toBe("Toutes les ventes pendant un mois : 59 €");
    expect(texts.subscriptionText).toBe(
      "Sans engagement. À partir de quatre ventes à l’unité, l’abonnement revient moins cher.",
    );
    expect(texts.subscriptionDeduction).toBeNull();
    expect(texts.saleTitle).toBe("Cette vente : 19 €");
    expect(texts.saleDeduction).toBe(
      "Si vous vous abonnez dans les 30 jours, ces 19 € sont déduits de votre premier mois.",
    );
    expect(texts.saleCallToAction).toBe("Acheter cette vente : 19 €");

    const other = saleUnlockPurchaseChoiceTexts({
      unit: { label: "21 €", amountCents: 2100 },
      subscriptionLabel: "69 € TTC / mois",
      subscriptionCents: 6900,
      firstMonthDeductionCents: 4200,
    });
    expect(plain(other.subscriptionTitle)).toBe("Toutes les ventes pendant un mois : 69 €");
    expect(plain(other.subscriptionDeduction)).toBe(
      "Vos achats à l’unité des 30 derniers jours sont déduits : 27 € le premier mois, puis 69 € par mois.",
    );
    expect(other.saleDeduction).toBeNull();
    expect(other.saleCallToAction).toBe("Acheter cette vente : 21 €");
  });

  it("ne déduit jamais plus que le prix du mois", () => {
    const texts = saleUnlockPurchaseChoiceTexts({
      unit: { label: "19 €", amountCents: 1900 },
      subscriptionLabel: "59 € TTC / mois",
      subscriptionCents: 5900,
      firstMonthDeductionCents: 7600,
    });
    expect(plain(texts.subscriptionDeduction)).toContain(": 0 € le premier mois");
  });

  it("reprend le libellé de l'abonnement tel quel quand son prix ne s'y lit pas, sans comparer", () => {
    const texts = saleUnlockPurchaseChoiceTexts({
      unit: { label: "19 €", amountCents: 1900 },
      subscriptionLabel: "Analyse",
      subscriptionCents: null,
      firstMonthDeductionCents: 1900,
    });
    expect(texts.subscriptionTitle).toBe("Toutes les ventes pendant un mois : Analyse");
    expect(texts.subscriptionText).toBe("Sans engagement.");
    expect(texts.subscriptionDeduction).toBeNull();
  });

  it("donne une ligne et une phrase pour /offres, la comparaison seulement si elle se calcule", () => {
    expect(salePurchaseOfferLine("19 €")).toBe("Vente supplémentaire à l’unité : 19 €");
    expect(salePurchaseOffersNote({ unitCents: 1900, subscriptionCents: 5900 })).toBe(
      "Vous n’avez besoin que d’une vente de plus ? Elle s’achète à l’unité. À partir de quatre ventes, l’abonnement revient moins cher.",
    );
    // 59 € / 5 € : 12 ventes, écrit en chiffres au-delà de dix.
    expect(salePurchaseOffersNote({ unitCents: 500, subscriptionCents: 5900 })).toBe(
      "Vous n’avez besoin que d’une vente de plus ? Elle s’achète à l’unité. À partir de 12 ventes, l’abonnement revient moins cher.",
    );
    expect(salePurchaseOffersNote({ unitCents: 1900, subscriptionCents: null })).toBe(
      "Vous n’avez besoin que d’une vente de plus ? Elle s’achète à l’unité.",
    );
  });

  it("a un message pour chaque refus de la route, et seulement pour eux", () => {
    expect(Object.keys(SALE_UNLOCK_CHECKOUT_CONFLICT_TEXTS).sort()).toEqual(
      [...SALE_UNLOCK_PURCHASE_REFUSAL_CODES].sort(),
    );
  });

  it("dit les crédits disponibles et la source d'un déblocage quand elle est connue", () => {
    expect(unlockCreditsLine({})).toBeNull();
    expect(unlockCreditsLine({ credits: 0 })).toBeNull();
    expect(unlockCreditsLine({ credits: 1 })).toBe("1 crédit de déblocage disponible");
    expect(unlockCreditsLine({ credits: 2 })).toBe("2 crédits de déblocage disponibles");
    expect(unlockSourceLabel("free")).toBe("Débloquée avec le compte gratuit");
    expect(unlockSourceLabel("purchase")).toBe("Achetée");
    expect(unlockSourceLabel("credit")).toBe("Débloquée avec un crédit");
    expect(unlockSourceLabel(null)).toBeNull();
    expect(unlockSourceLabel(undefined)).toBeNull();
  });

  it("n'écrit aucun prix en toutes lettres dans les textes de l'achat", () => {
    const source = readFileSync(resolve("src/lib/sale-unlocks.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/\d+[ \u00a0]?€/);
  });
});
