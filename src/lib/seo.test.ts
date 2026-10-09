import { describe, expect, it } from "vitest";
import type { AuctionSale } from "@/lib/types";
import {
  atTribunal,
  GENERIC_SALE_SEO_TITLE,
  organizationStructuredData,
  SALE_TITLE_MAX_LENGTH,
  saleHeadline,
  saleHearingStartDate,
  saleHearingTime,
  saleReference,
  saleSeoDescription,
  saleSeoTitle,
  saleStructuredData,
  tribunalCityName,
  tribunalDisplayName,
} from "./seo";

const NOW = new Date("2026-10-09T10:00:00Z");

function sale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    id: "005a914d-563c-427b-88a4-740cbf851afb",
    property_type: "apartment",
    app_surface_m2: 50,
    city: "Romainville",
    department: "93",
    sale_venue_type: "tribunal",
    sale_verification_status: "verified",
    sale_date: "2026-10-20T09:00:00+02:00",
    starting_price_eur: 85_000,
    tribunal: "TJ Bobigny",
    tribunal_name: null,
    tribunal_city: null,
    media: [{ type: "image", url: "https://media.example.test/photo.jpg" }],
    updated_at: "2026-10-08T08:00:00Z",
    ...overrides,
  } as AuctionSale;
}

describe("sale headline", () => {
  it("builds the heading announced by the plan", () => {
    expect(saleHeadline(sale())).toBe(
      "Appartement 50 m² à Romainville (93) – vente au tribunal le 20 octobre 2026",
    );
  });

  it("describes the other procedures without inventing a tribunal", () => {
    expect(saleHeadline(sale({ sale_venue_type: "notary" }))).toContain("vente chez le notaire");
    expect(saleHeadline(sale({ sale_venue_type: "state" }))).toContain("vente par l’État");
  });

  it("leaves out what is unknown instead of inventing it", () => {
    expect(
      saleHeadline(sale({ app_surface_m2: null, city: null, department: null, sale_date: null })),
    ).toBe("Appartement – vente au tribunal");
    expect(saleHeadline(sale({ property_type: null }))).toMatch(/^Bien immobilier 50 m²/);
  });

  it("is the generic title when there is no sale", () => {
    expect(saleHeadline(null)).toBe(GENERIC_SALE_SEO_TITLE);
  });

  it("never gives two different lots the same reference", () => {
    const first = saleReference("005a914d-563c-427b-88a4-740cbf851afb");
    const second = saleReference("0f1e2d3c-563c-427b-88a4-740cbf851afb");
    expect(first).toBe("005a914d");
    expect(first).not.toBe(second);
  });
});

describe("sale title", () => {
  it("never contains the site name (the layout template adds it)", () => {
    for (const candidate of [sale(), sale({ sale_venue_type: "state" }), null]) {
      expect(saleSeoTitle(candidate)).not.toMatch(/immojudis/i);
    }
    expect(GENERIC_SALE_SEO_TITLE).not.toMatch(/immojudis/i);
  });

  it("stays within 60 characters once the layout suffix is added", () => {
    const long = sale({ city: "Saint-Rémy-lès-Chevreuse-sur-Mer-de-la-Vallée", department: "78" });
    for (const candidate of [sale(), long, sale({ city: null })]) {
      const title = saleSeoTitle(candidate);
      expect(title.length).toBeLessThanOrEqual(SALE_TITLE_MAX_LENGTH);
      expect(`${title} - Immojudis`.length).toBeLessThanOrEqual(60);
    }
  });

  it("keeps the most informative variant that fits", () => {
    expect(saleSeoTitle(sale())).toBe("Appartement 50 m² à Romainville (93) – tribunal");
    expect(saleSeoTitle(sale({ city: "Saint-Germain-en-Laye" }))).toBe(
      "Appartement à Saint-Germain-en-Laye – tribunal",
    );
  });

  it("does not repeat the tribunal wording", () => {
    for (const name of ["TJ Bobigny", "Tribunal judiciaire de Bobigny"]) {
      const text = `${saleSeoTitle(sale({ tribunal: name }))} ${saleSeoDescription(sale({ tribunal: name }))}`;
      expect(text).not.toMatch(/tribunal\s+tribunal/i);
    }
  });
});

describe("sale description", () => {
  it("starts with a capital and names the tribunal once", () => {
    const description = saleSeoDescription(sale());
    expect(description).toMatch(/^[A-ZÀÂÉÈÊÎÔÛ]/);
    expect(description).toContain("au tribunal judiciaire de Bobigny le 20 octobre 2026");
    expect(description).toContain("Mise à prix : 85 000 €");
    expect(description).toMatch(/\.$/); // never cut in the middle of a sentence
    expect(description).not.toMatch(/au tribunal Tribunal/);
    expect(description.length).toBeLessThanOrEqual(158);
  });

  it("has a generic, accented fallback", () => {
    expect(saleSeoDescription(null)).toMatch(/^Vente aux enchères immobilière/);
  });
});

describe("tribunal names", () => {
  it.each([
    ["TJ Perpignan", "Perpignan"],
    ["Tribunal judiciaire de Bordeaux", "Bordeaux"],
    ["TJ d'Aix-en-Provence", "Aix-en-Provence"],
    ["Tribunal judiciaire d’Avignon", "Avignon"],
    ["TJ", null],
  ])("reduces %s to its city", (raw, city) => {
    expect(tribunalCityName(raw)).toBe(city);
  });

  it("writes the article correctly", () => {
    expect(tribunalDisplayName({ tribunal: "TJ Perpignan" })).toBe(
      "Tribunal judiciaire de Perpignan",
    );
    expect(tribunalDisplayName({ tribunal: "TJ Avignon" })).toBe("Tribunal judiciaire d’Avignon");
    expect(tribunalDisplayName({ tribunal: "TJ Le Mans" })).toBe("Tribunal judiciaire du Mans");
    expect(tribunalDisplayName({ tribunal: "Tribunal de proximité de Lunel" })).toBe(
      "Tribunal de proximité de Lunel",
    );
  });
});

describe("court in a sentence", () => {
  it("takes the article for a tribunal and keeps 'auprès de' for anything else", () => {
    expect(atTribunal("Tribunal judiciaire de Bordeaux")).toBe(
      "au tribunal judiciaire de Bordeaux",
    );
    expect(atTribunal("TJ Nantes")).toBe("au tribunal judiciaire de Nantes");
    expect(atTribunal("Étude de Me Dupont")).toBe("auprès de Étude de Me Dupont");
  });
});

describe("hearing time", () => {
  it("only shows a time that is really known", () => {
    expect(saleHearingTime("2026-10-23T00:00:00+00:00")).toBeNull();
    expect(saleHearingTime("2026-10-22T22:00:00+00:00")).toBeNull(); // midnight in Paris
    expect(saleHearingTime("2026-10-20T07:30:00+00:00")).toBe("9 h 30");
    expect(saleHearingStartDate("2026-10-23T00:00:00+00:00")).toBe("2026-10-23");
    expect(saleHearingStartDate("2026-10-20T07:30:00+00:00")).toBe("2026-10-20T07:30:00.000Z");
  });
});

describe("sale structured data", () => {
  const origin = "https://immojudis.com";

  it("uses absolute URLs and the facts of the page", () => {
    const data = saleStructuredData(sale(), { origin, now: NOW }) as {
      "@graph": Array<Record<string, unknown>>;
    };
    const listing = data["@graph"][0];
    expect(listing["@type"]).toBe("RealEstateListing");
    expect(listing.url).toBe(`${origin}/sales/005a914d-563c-427b-88a4-740cbf851afb`);
    expect(listing.image).toEqual(["https://media.example.test/photo.jpg"]);
    expect(JSON.stringify(data)).not.toMatch(/"url":"\//);
  });

  it("describes the starting price as an opening bid, not an asking price", () => {
    const data = saleStructuredData(sale(), { origin, now: NOW }) as {
      "@graph": Array<{ offers?: Record<string, unknown> }>;
    };
    const offers = data["@graph"][0].offers!;
    expect(offers).not.toHaveProperty("price");
    expect(offers.priceSpecification).toMatchObject({ name: "Mise à prix", price: 85_000 });
    expect(offers.availability).toBe("https://schema.org/LimitedAvailability");
  });

  it("switches availability to SoldOut once the hearing is over", () => {
    const data = saleStructuredData(sale({ sale_date: "2026-10-01T09:00:00+02:00" }), {
      origin,
      now: NOW,
    }) as { "@graph": Array<{ offers?: { availability: string } }> };
    expect(data["@graph"][0].offers?.availability).toBe("https://schema.org/SoldOut");
  });

  it("adds the hearing as an event only when date and court are known", () => {
    const withEvent = saleStructuredData(sale(), { origin, now: NOW }) as {
      "@graph": Array<Record<string, unknown>>;
    };
    expect(withEvent["@graph"]).toHaveLength(2);
    expect(withEvent["@graph"][1]).toMatchObject({
      "@type": "Event",
      startDate: "2026-10-20T07:00:00.000Z",
      location: {
        name: "Tribunal judiciaire de Bobigny",
        address: { addressLocality: "Bobigny" },
      },
    });
    for (const incomplete of [
      sale({ sale_date: null }),
      sale({ tribunal: null }),
      sale({ sale_venue_type: "notary" }),
    ]) {
      const data = saleStructuredData(incomplete, { origin, now: NOW }) as {
        "@graph": unknown[];
      };
      expect(data["@graph"]).toHaveLength(1);
    }
  });

  it("omits the offer and the image when the page has none", () => {
    const data = saleStructuredData(sale({ starting_price_eur: null, media: [] }), {
      origin,
      now: NOW,
    }) as { "@graph": Array<Record<string, unknown>> };
    expect(data["@graph"][0]).not.toHaveProperty("offers");
    expect(data["@graph"][0]).not.toHaveProperty("image");
  });
});

describe("organization structured data", () => {
  it("declares the organization with an absolute logo and the website search", () => {
    const data = organizationStructuredData("https://immojudis.com") as {
      "@graph": Array<Record<string, unknown>>;
    };
    const [organization, website] = data["@graph"];
    expect(organization).toMatchObject({
      "@type": "Organization",
      name: "Immojudis",
      logo: { url: "https://immojudis.com/brand/immojudis-mark-transparent.png" },
    });
    expect(website).toMatchObject({
      "@type": "WebSite",
      url: "https://immojudis.com",
      potentialAction: {
        target: { urlTemplate: "https://immojudis.com/sales?q={search_term_string}" },
      },
    });
  });
});
