import { describe, expect, it } from "vitest";
import { photoCredit } from "./photo-credit";
import type { AuctionSale } from "./types";

const sale = {
  source_name: "licitor",
  source_url: "https://www.licitor.com/annonce/1/2/3/vente.html",
  source_urls: [
    "https://www.licitor.com/annonce/1/2/3/vente.html",
    "https://www.info-encheres.com/vente/42",
  ],
} as unknown as AuctionSale;

describe("photoCredit", () => {
  it("nomme la source d'après l'hôte de la photo et renvoie vers l'annonce de cette source", () => {
    expect(photoCredit("https://www.licitor.com/photos/a.jpg", sale)).toEqual({
      label: "Licitor",
      href: "https://www.licitor.com/annonce/1/2/3/vente.html",
    });
    expect(photoCredit("https://www.info-encheres.com/photos/9/a.jpg", sale)).toEqual({
      label: "Info-Enchères",
      href: "https://www.info-encheres.com/vente/42",
    });
  });

  it("reconnaît les hôtes de médias des sources", () => {
    expect(photoCredit("https://media.immobilier.notaires.fr/inotr/media/a.jpg")?.label).toBe(
      "Immobilier.notaires",
    );
    expect(photoCredit("https://www.vench.fr/vignettes/v1.jpg")?.label).toBe("Vench");
  });

  it("n'affiche pas de lien vers une autre source que celle de la photo", () => {
    expect(photoCredit("https://www.vench.fr/vignettes/v1.jpg", sale)).toEqual({
      label: "Vench",
      href: null,
    });
  });

  it("sans annonce d'origine connue, le nom seul", () => {
    expect(photoCredit("https://www.licitor.com/photos/a.jpg", null)).toEqual({
      label: "Licitor",
      href: null,
    });
  });

  it("hôte inconnu : crédit générique sans nom ni lien, jamais l'hôte brut", () => {
    expect(photoCredit("https://d1x9.cloudfront.net/p.jpg", null)).toEqual({
      label: null,
      href: null,
    });
    // Même avec une vente et ses liens : on ne renvoie pas vers une autre source.
    expect(photoCredit("https://d1x9.cloudfront.net/p.jpg", sale)).toEqual({
      label: null,
      href: null,
    });
  });

  it("mode « sources connues » : aucun crédit pour un hôte inconnu", () => {
    expect(photoCredit("https://cdn.exemple.test/p.jpg", null, { knownOnly: true })).toBeNull();
  });

  it("ne donne rien sans URL exploitable", () => {
    expect(photoCredit(undefined, sale)).toBeNull();
    expect(photoCredit("pas une url", sale, { knownOnly: true })).toBeNull();
  });

  it("ne se laisse pas tromper par l'URL d'une copie hébergée", () => {
    // La copie est chez Supabase ; le crédit ne se lit que sur l'URL d'origine.
    expect(
      photoCredit(
        "https://ci.supabase.co/storage/v1/object/public/sale-photos/a/b-640.webp",
        sale,
        { knownOnly: true },
      ),
    ).toBeNull();
  });
});
