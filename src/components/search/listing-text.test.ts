import { describe, expect, it } from "vitest";
import type { AuctionSale } from "@/lib/types";
import {
  LISTING_DETAIL_LINE,
  PAST_SALE_LABEL,
  listingAccessLine,
  listingDateLabel,
  listingLinkLabel,
} from "./listing-text";

const tribunal = { id: "a", sale_venue_type: "tribunal" } as unknown as AuctionSale;
const notary = { id: "b", sale_venue_type: "notary" } as unknown as AuctionSale;
const FREE_LINE = "Gratuit, sans carte bancaire · 3 fiches détaillées par mois";

describe("listingAccessLine", () => {
  it("promet un compte gratuit au visiteur sans compte", () => {
    const access = { locked: true, analysisLocked: false, unlocked: false };
    expect(listingAccessLine(tribunal, access)).toBe(FREE_LINE);
    expect(listingAccessLine(notary, access)).toBe("Fiche complète avec un compte gratuit");
  });

  it("reste neutre pour un compte reconnu dont les droits sont en cours de vérification", () => {
    const access = { locked: true, analysisLocked: false, unlocked: false, verifying: true };
    expect(listingAccessLine(tribunal, access)).toBe(LISTING_DETAIL_LINE);
    expect(listingAccessLine(notary, access)).toBe(LISTING_DETAIL_LINE);
  });

  it("garde les lignes d'un compte dont les droits sont connus", () => {
    expect(
      listingAccessLine(tribunal, { locked: false, analysisLocked: true, unlocked: false }),
    ).toBe(FREE_LINE);
    expect(
      listingAccessLine(tribunal, { locked: false, analysisLocked: true, unlocked: true }),
    ).toBe(LISTING_DETAIL_LINE);
    expect(
      listingAccessLine(tribunal, { locked: false, analysisLocked: false, unlocked: false }),
    ).toBe(LISTING_DETAIL_LINE);
  });
});

describe("listingDateLabel", () => {
  const now = new Date("2026-10-19T10:00:00Z");
  const on = (sale_date: string | null) => ({ sale_date }) as unknown as AuctionSale;

  it("remplace une date passée par « Vente passée »", () => {
    expect(listingDateLabel(on("2020-03-12T09:00:00Z"), now)).toBe(PAST_SALE_LABEL);
    expect(listingDateLabel(on("2026-10-18T10:00:00Z"), now)).toBe(PAST_SALE_LABEL);
    expect(PAST_SALE_LABEL).toBe("Vente passée");
  });

  it("garde la date d'aujourd'hui jusqu'à minuit (heure de Paris), même une fois l'heure passée", () => {
    expect(listingDateLabel(on("2026-10-19T08:00:00Z"), now)).toContain("19 octobre 2026");
    expect(listingDateLabel(on("2026-10-19"), now)).toContain("19 octobre 2026");
  });

  it("garde la date d'une vente à venir", () => {
    expect(listingDateLabel(on("2026-11-20T14:00:00Z"), now)).toContain("20 novembre 2026");
  });

  it("garde « Date à confirmer » quand la date manque ou est illisible", () => {
    expect(listingDateLabel(on(null), now)).toBe("Date à confirmer");
    expect(listingDateLabel(on("pas une date"), now)).toBe("Date à confirmer");
  });
});

describe("listingLinkLabel", () => {
  const base = { id: "a" } as unknown as AuctionSale;

  it("ajoute le prix publié au titre", () => {
    expect(listingLinkLabel({ ...base, starting_price_eur: 90_000 }, "Maison · Pau")).toMatch(
      /^Voir Maison · Pau, 90\s000\s€$/,
    );
  });

  it("prend la date quand il n'y a pas de prix (ou un prix de 0 €, jamais écrit)", () => {
    const dated = { ...base, sale_date: "2099-03-12T09:00:00Z" };
    expect(listingLinkLabel({ ...dated, starting_price_eur: null }, "Maison")).toMatch(
      /^Voir Maison, vente le .*mars 2099$/,
    );
    expect(listingLinkLabel({ ...dated, starting_price_eur: 0 }, "Maison")).toMatch(
      /vente le .*mars 2099$/,
    );
  });

  it("dit « vente passée » plutôt qu'une date ancienne", () => {
    expect(
      listingLinkLabel({ ...base, sale_date: "2020-03-12T09:00:00Z" } as AuctionSale, "Maison"),
    ).toBe("Voir Maison, vente passée");
  });

  it("n'écrit pas une valeur masquée par la relecture", () => {
    const sale = { ...base, starting_price_eur: 90_000, sale_date: "2099-03-12T09:00:00Z" };
    expect(listingLinkLabel(sale, "Maison", { price: true })).toMatch(/vente le /);
    expect(listingLinkLabel(sale, "Maison", { price: true, date: true })).toBe("Voir Maison");
  });

  it("garde « Voir <titre> » sans prix ni date", () => {
    expect(listingLinkLabel(base, "Maison")).toBe("Voir Maison");
  });
});
