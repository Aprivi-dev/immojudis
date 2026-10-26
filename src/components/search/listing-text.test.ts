import { describe, expect, it } from "vitest";
import type { AuctionSale } from "@/lib/types";
import {
  LISTING_DETAIL_LINE,
  LISTING_LAUNCH_OFFER_LINE,
  PAST_SALE_LABEL,
  listingAccessLine,
  listingDateLabel,
  listingLinkLabel,
  listingPriceText,
  stateSaleWithoutPrice,
} from "./listing-text";

const tribunal = { id: "a", sale_venue_type: "tribunal" } as unknown as AuctionSale;
const notary = { id: "b", sale_venue_type: "notary" } as unknown as AuctionSale;
const state = { id: "c", sale_venue_type: "state" } as unknown as AuctionSale;
const unknownVenue = { id: "d", sale_venue_type: "unknown" } as unknown as AuctionSale;
const FREE_LINE = "Gratuit, sans carte bancaire · 3 fiches détaillées par mois";

describe("listingAccessLine", () => {
  it("promet un compte gratuit au visiteur sans compte", () => {
    const access = { locked: true, analysisLocked: false, unlocked: false };
    expect(listingAccessLine(tribunal, access)).toBe(FREE_LINE);
    // Le déblocage ouvre le plafond des ventes notariales (bougie ou interactive) comme celui du tribunal.
    expect(listingAccessLine(notary, access)).toBe(FREE_LINE);
    // Ventes domaniales et type inconnu : pas de plafond, donc rien à débloquer de plus.
    expect(listingAccessLine(state, access)).toBe("Fiche complète avec un compte gratuit");
    expect(listingAccessLine(unknownVenue, access)).toBe("Fiche complète avec un compte gratuit");
  });

  it("propose le déblocage d'une vente notariale à un compte gratuit, pas d'une vente domaniale", () => {
    const access = { locked: false, analysisLocked: true, unlocked: false };
    expect(listingAccessLine(notary, access)).toBe(FREE_LINE);
    expect(listingAccessLine(state, access)).toBe(LISTING_DETAIL_LINE);
    expect(listingAccessLine(notary, { ...access, unlocked: true })).toBe(LISTING_DETAIL_LINE);
  });

  it("ne promet pas de déblocage d'une vente notariale quand l'interrupteur ferme ses régimes", () => {
    const tribunalOnly = ["tribunal"] as const;
    const visitor = { locked: true, analysisLocked: false, unlocked: false };
    const freeAccount = { locked: false, analysisLocked: true, unlocked: false };
    expect(listingAccessLine(notary, { ...visitor, openFeeRegimes: tribunalOnly })).toBe(
      "Fiche complète avec un compte gratuit",
    );
    expect(listingAccessLine(notary, { ...freeAccount, openFeeRegimes: tribunalOnly })).toBe(
      LISTING_DETAIL_LINE,
    );
    // Le tribunal reste ouvert, et une seule de ses deux formes notariales suffit.
    expect(listingAccessLine(tribunal, { ...freeAccount, openFeeRegimes: tribunalOnly })).toBe(
      FREE_LINE,
    );
    expect(
      listingAccessLine(notary, { ...freeAccount, openFeeRegimes: ["tribunal", "notary_online"] }),
    ).toBe(FREE_LINE);
  });

  it("reste neutre pour un compte reconnu dont les droits sont en cours de vérification", () => {
    const access = { locked: true, analysisLocked: false, unlocked: false, verifying: true };
    expect(listingAccessLine(tribunal, access)).toBe(LISTING_DETAIL_LINE);
    expect(listingAccessLine(notary, access)).toBe(LISTING_DETAIL_LINE);
  });

  it("reste neutre tant que l'état de l'offre de lancement est inconnu (rendu serveur compris)", () => {
    for (const access of [
      { locked: true, analysisLocked: true, unlocked: false },
      { locked: false, analysisLocked: true, unlocked: false },
    ]) {
      expect(listingAccessLine(tribunal, { ...access, launchPending: true })).toBe(
        LISTING_DETAIL_LINE,
      );
      expect(listingAccessLine(notary, { ...access, launchPending: true })).toBe(
        LISTING_DETAIL_LINE,
      );
    }
    expect(
      listingAccessLine(tribunal, {
        locked: true,
        analysisLocked: true,
        unlocked: false,
        launchOffer: true,
      }),
    ).toBe(LISTING_LAUNCH_OFFER_LINE);
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

describe("prix d'une cession domaniale", () => {
  const state = (price: number | null | undefined) =>
    ({ id: "c", sale_venue_type: "state", starting_price_eur: price }) as unknown as AuctionSale;

  it("dit « Prix non publié » pour une cession domaniale sans prix (absent ou nul)", () => {
    for (const price of [null, undefined, 0]) {
      expect(stateSaleWithoutPrice(state(price))).toBe(true);
      expect(listingPriceText(state(price))).toBe("Prix non publié");
    }
  });

  it("garde le prix d'une cession domaniale qui en publie un", () => {
    expect(stateSaleWithoutPrice(state(125_000))).toBe(false);
    expect(listingPriceText(state(125_000))).toMatch(/^125\s000\s€$/);
  });

  it("ne change rien pour le tribunal et le notaire : « Prix non communiqué » sans prix", () => {
    for (const venue of ["tribunal", "notary", "online", "unknown"]) {
      const sale = {
        id: "d",
        sale_venue_type: venue,
        starting_price_eur: 0,
      } as unknown as AuctionSale;
      expect(stateSaleWithoutPrice(sale)).toBe(false);
      expect(listingPriceText(sale)).toBe("Prix non communiqué");
    }
  });
});

describe("listingLinkLabel d'une pépite", () => {
  const pepiteSale = {
    id: "p",
    sale_venue_type: "tribunal",
    starting_price_eur: 90_000,
  } as unknown as AuctionSale;

  it("ajoute « , pépite » au nom accessible du lien de la carte", () => {
    const plain = listingLinkLabel(pepiteSale, "Maison · Pau");
    expect(listingLinkLabel(pepiteSale, "Maison · Pau", { pepite: true })).toBe(`${plain}, pépite`);
    expect(plain).not.toContain("pépite");
  });

  it("garde le mot même quand le prix et la date sont masqués par la relecture", () => {
    expect(
      listingLinkLabel(pepiteSale, "Maison · Pau", { price: true, date: true, pepite: true }),
    ).toBe("Voir Maison · Pau, pépite");
  });
});
