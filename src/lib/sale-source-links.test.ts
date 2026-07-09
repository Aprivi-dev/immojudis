import { describe, expect, it } from "vitest";
import { saleSourceLinks, sourceLabel, sourceLabelFromUrl } from "@/lib/sale-source-links";
import type { AuctionSale } from "@/lib/types";

describe("sale source links", () => {
  it("labels merged source URLs from known domains", () => {
    const sale = {
      source_name: "avoventes",
      source_url: "https://avoventes.fr/enchere/maison",
      source_urls: [
        "https://avoventes.fr/enchere/maison",
        "https://www.licitor.com/annonce/10/maison.html",
        "https://www.info-encheres.com/vente-maison.html",
      ],
    } as AuctionSale;

    expect(saleSourceLinks(sale)).toEqual([
      { label: "Avoventes", href: "https://avoventes.fr/enchere/maison" },
      { label: "Licitor", href: "https://www.licitor.com/annonce/10/maison.html" },
      { label: "Info-Enchères", href: "https://www.info-encheres.com/vente-maison.html" },
    ]);
  });

  it("uses object keys as source names when they are explicit", () => {
    const sale = {
      source_name: "encheres_immobilieres",
      source_url: "https://encheresimmobilieres.fr/ventes/1",
      source_urls: {
        licitor: "https://www.licitor.com/annonce/1.html",
      },
    } as unknown as AuctionSale;

    expect(saleSourceLinks(sale)).toEqual([
      { label: "Enchères Immobilières", href: "https://encheresimmobilieres.fr/ventes/1" },
      { label: "Licitor", href: "https://www.licitor.com/annonce/1.html" },
    ]);
  });

  it("falls back to the host or provided source name", () => {
    expect(sourceLabelFromUrl("https://cabinet.example.test/vente/1")).toBe("cabinet.example.test");
    expect(sourceLabel("cabinet_local", null)).toBe("cabinet_local");
  });
});
