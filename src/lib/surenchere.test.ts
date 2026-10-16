import { describe, expect, it } from "vitest";
import { MAX_SURENCHERE_PRICE_EUR, minimumSurenchere } from "./surenchere";
import { getSurenchereReminder } from "./surenchere-reminder";
import afterAward from "@/content/resources/apres-adjudication-surenchere-paiement-titre-vente.json";

describe("minimumSurenchere", () => {
  it.each([
    [100_000, 10_000, 110_000],
    [85_000, 8_500, 93_500],
    [200_000, 20_000, 220_000],
    [1, 0.1, 1.1],
  ])("ajoute 10 %% à %d € : dixième %d €, surenchère minimale %d €", (price, tenth, minimum) => {
    expect(minimumSurenchere(price)).toEqual({
      principalPrice: price,
      tenth,
      minimumBid: minimum,
    });
  });

  it("n'a pas l'erreur de virgule flottante de 100 000 × 1,1", () => {
    expect(100_000 * 1.1).not.toBe(110_000);
    expect(minimumSurenchere(100_000)?.minimumBid).toBe(110_000);
    expect(minimumSurenchere(333_333)?.minimumBid).toBeCloseTo(366_666.3, 6);
  });

  it("arrondit le dixième au centime supérieur : la surenchère ne peut pas être plus faible", () => {
    const amounts = minimumSurenchere(10_000.05)!;
    // Un dixième de 10 000,05 est 1 000,005 : 1 000,01 au centime supérieur.
    expect(amounts.tenth).toBe(1_000.01);
    expect(amounts.minimumBid).toBe(11_000.06);
    expect(amounts.tenth * 10).toBeGreaterThanOrEqual(amounts.principalPrice);
  });

  it("garde un dixième au moins égal à 10 % du prix, pour toute une série de prix", () => {
    for (let price = 1; price <= 300_000; price += 7_919) {
      const amounts = minimumSurenchere(price)!;
      expect(amounts.tenth * 10).toBeGreaterThanOrEqual(price - 1e-6);
      expect(amounts.minimumBid).toBeCloseTo(price + amounts.tenth, 6);
      expect(amounts.minimumBid).toBeGreaterThan(price);
    }
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])("ne calcule rien pour %s", (price) => {
    expect(minimumSurenchere(price)).toBeNull();
  });

  it("calcule jusqu'au plafond de dix milliards d'euros, et rien au-delà", () => {
    expect(MAX_SURENCHERE_PRICE_EUR).toBe(1e10);
    expect(minimumSurenchere(MAX_SURENCHERE_PRICE_EUR)).toEqual({
      principalPrice: 1e10,
      tenth: 1e9,
      minimumBid: 1.1e10,
    });
    for (const price of [MAX_SURENCHERE_PRICE_EUR + 1, 1e16, 1e300, Number.MAX_VALUE]) {
      expect(minimumSurenchere(price)).toBeNull();
    }
  });
});

describe("getSurenchereReminder", () => {
  it("reprend mot pour mot le délai de l'article, sans le réécrire", () => {
    const reminder = getSurenchereReminder();
    expect(reminder).not.toBeNull();
    expect(afterAward.takeaways).toContain(reminder!.delay);
    expect(reminder!.delay).toContain("Pendant dix jours");
    expect(reminder!.delay).toContain("au moins un dixième du prix principal");
  });

  it("reprend la portée de la règle telle que l'article la formule", () => {
    const reminder = getSurenchereReminder()!;
    const bullets = afterAward.sections.flatMap((section) => section.bullets ?? []);
    expect(reminder.scope).not.toBeNull();
    expect(bullets).toContain(reminder.scope);
    expect(reminder.scope).toContain("saisie immobilière");
    expect(reminder.scope).toContain("vente notariale");
  });

  it("renvoie vers l'article", () => {
    const reminder = getSurenchereReminder()!;
    expect(reminder.articleHref).toBe(`/ressources/${afterAward.slug}`);
    expect(reminder.articleTitle).toBe(afterAward.title);
  });
});
