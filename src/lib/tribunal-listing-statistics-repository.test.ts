import { beforeEach, describe, expect, it, vi } from "vitest";

const { serverFrom } = vi.hoisted(() => ({ serverFrom: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: serverFrom },
}));

import {
  courtAliasMatchesOfficialName,
  deduplicateTribunalListingSales,
  extractTribunalIdentityAddress,
  extractTribunalLegalReference,
  getTribunalListingStatistics,
} from "@/lib/tribunal-listing-statistics-repository";

type DeduplicationSale = Parameters<typeof deduplicateTribunalListingSales>[0][number];

const AS_OF = new Date("2026-08-20T12:00:00.000Z");

describe("tribunal listing statistics repository", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inclut les lignes sans code via un alias officiel, puis déduplique avec l’adresse forte", async () => {
    const courtQuery = fakeQuery({
      data: {
        code: "justice_tj_1_112",
        name: "TJ Saint-Etienne",
        judicial_region: "Lyon",
      },
      error: null,
    });
    const aliasesQuery = fakeQuery({
      data: {
        code: "justice_tj_1_112",
        canonical_name: "TJ Saint-Etienne",
        aliases: ["TJ DE SAINT-ETIENNE", "Tribunal judiciaire de Saint-Etienne"],
      },
      error: null,
    });
    const officialAliasesQuery = fakeQuery({
      data: {
        court_code: "justice_tj_1_112",
        official_name: "Tribunal judiciaire de Saint-Etienne",
      },
      error: null,
    });
    const directSale = saleRow("11111111-1111-4111-8111-111111111111", "petites_affiches");
    directSale.raw_payload = {
      source_blocks: { page_text: "Pub. légale : 01/06/2026" },
    };
    const directQuery = fakeQuery({ data: [directSale], error: null });
    const nullScanQuery = fakeQuery({
      data: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          tribunal: "Tribunal judiciaire de Saint-Étienne",
          tribunal_code: null,
          sale_venue_type: "tribunal",
          sale_verification_status: "verified",
          status: "past",
          first_seen_at: "2026-06-01T09:00:00.000Z",
          publication_quarantine: null,
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          tribunal: "Saint-Étienne",
          tribunal_code: null,
          sale_venue_type: "tribunal",
          sale_verification_status: "verified",
          status: "past",
          first_seen_at: "2026-06-01T09:00:00.000Z",
          publication_quarantine: null,
        },
      ],
      error: null,
    });
    const nullDetailQuery = fakeQuery({
      data: [saleRow("22222222-2222-4222-8222-222222222222", "avoventes")],
      error: null,
    });
    const estimatesQuery = fakeQuery({ data: [], error: null });
    serverFrom
      .mockReturnValueOnce(courtQuery.query)
      .mockReturnValueOnce(aliasesQuery.query)
      .mockReturnValueOnce(officialAliasesQuery.query)
      .mockReturnValueOnce(directQuery.query)
      .mockReturnValueOnce(nullScanQuery.query)
      .mockReturnValueOnce(nullDetailQuery.query)
      .mockReturnValueOnce(estimatesQuery.query);

    const result = await getTribunalListingStatistics(
      { courtCode: "justice_tj_1_112", historyMonths: 3 },
      { asOf: AS_OF },
    );

    expect(result.activity.observedAnnouncements).toBe(1);
    expect(result.activity.publicationDatesKnown).toBe(1);
    expect(result.activity.discoveryDatesUsed).toBe(0);
    expect(result.meta.rawAnnouncements).toBe(2);
    expect(result.meta.deduplicatedAnnouncements).toBe(1);
    expect(result.meta.sources).toEqual(["avoventes", "petites_affiches"]);
    expect(serverFrom).toHaveBeenNthCalledWith(4, "auction_sales");
    expect(serverFrom).toHaveBeenNthCalledWith(5, "auction_sales");
    expect(nullScanQuery.state.selected).toContain("id");
    expect(nullScanQuery.state.selected).not.toBe(directQuery.state.selected);
    expect(nullScanQuery.state.filters).toContainEqual(["is", "tribunal_code", null]);
    expect(nullDetailQuery.state.filters).toContainEqual([
      "in",
      "id",
      ["22222222-2222-4222-8222-222222222222"],
    ]);
  });

  it("ne traite jamais une ville nue comme une affectation officielle de tribunal", () => {
    const aliases = ["TJ Saint-Etienne", "Tribunal judiciaire de Saint-Etienne"];
    expect(courtAliasMatchesOfficialName("Tribunal judiciaire de Saint-Étienne", aliases)).toBe(
      true,
    );
    expect(courtAliasMatchesOfficialName("TJ DE SAINT ETIENNE", aliases)).toBe(true);
    expect(courtAliasMatchesOfficialName("Saint-Étienne", aliases)).toBe(false);
    expect(courtAliasMatchesOfficialName("TJ Bordeaux", aliases)).toBe(false);
  });

  it("relie les identifiants PA/Vench et conserve les sources sans preuve partagée", () => {
    const saintEtienneRows = [
      dedupeSale({
        id: "08b908ab-f2be-40c9-bb29-5bbd8971b3a1",
        sourceName: "petites_affiches",
        externalId: "165879",
        sourceUrl:
          "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/un-garage-a-saint-etienne-165879.html",
        sourceUrls: [
          "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/un-garage-a-saint-etienne-165879.html",
        ],
        title: "Un garage à Saint-Etienne",
        propertyType: "garage",
        city: "Saint-Étienne",
        startingPriceEur: 3_000,
        contentHash: "st-etienne-garage-165879",
      }),
      // Same source reference observed under a second PA URL in the
      // production inventory; it must not survive as a second announcement.
      dedupeSale({
        id: "228c32ca-fee1-4813-ba36-40d8e1b172b2",
        sourceName: "petites_affiches",
        externalId: "165879",
        sourceUrl:
          "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/un-garage-saint-etienne-165879.html",
        sourceUrls: [
          "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/un-garage-saint-etienne-165879.html",
        ],
        title: "Garage",
        propertyType: "other",
        city: "Saint-Etienne",
        startingPriceEur: 3_000,
        contentHash: "st-etienne-garage-165879",
      }),
      dedupeSale({
        id: "0b81f5b6-98c5-4ef3-bc0c-0946b0115dfd",
        sourceName: "vench",
        externalId: "165879",
        sourceUrl: "https://www.vench.fr/vente-165879-un-garage-saint-etienne.html",
        title: "Un garage Saint-Etienne",
        propertyType: "parking",
        city: "Saint-Etienne",
        startingPriceEur: 3_000,
      }),
      dedupeSale({
        id: "41cd1a64-ff0b-48ae-a58b-081117128f15",
        sourceName: "encheres_immobilieres",
        externalId: "9474",
        sourceUrl: "https://www.encheres-immobilieres.fr/annonce/9474",
        title: "Parking",
        propertyType: "parking",
        city: "Saint-Étienne",
        startingPriceEur: 3_000,
      }),
      dedupeSale({
        id: "46032f91-9b74-4eba-a1d9-713ec1c97385",
        sourceName: "licitor",
        externalId: "109892",
        sourceUrl: "https://www.licitor.com/annonce/saint-etienne/109892.html",
        title: "Parking",
        propertyType: "other",
        city: "Saint-Étienne",
        saleDate: "2026-10-15T12:00:00.000Z",
        startingPriceEur: 3_000,
      }),
    ];

    const deduplicated = deduplicateTribunalListingSales(saintEtienneRows);

    expect(deduplicated.sales).toHaveLength(3);
    expect(deduplicated.sales.map((sale) => sale.sourceNames).sort()).toEqual([
      ["encheres_immobilieres"],
      ["licitor"],
      ["petites_affiches", "vench"],
    ]);
  });

  it("conserve un avis Licitor multi-lots quand son prix recoupe un ancrage PA/Vench", () => {
    const rows = [
      dedupeSale({
        id: "pa-166405",
        sourceName: "petites_affiches",
        externalId: "166405",
        sourceUrl:
          "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/une-maison-d-habitation-a-juigne-des-moutiers-166405.html",
        title: "Une maison d habitation à Juigné-des-Moutiers",
        propertyType: "house",
        city: "Juigné-des-Moutiers",
        saleDate: "2026-10-16T00:00:00.000Z",
        startingPriceEur: 100_000,
      }),
      dedupeSale({
        id: "vench-166405",
        sourceName: "vench",
        externalId: "166405",
        sourceUrl: "https://www.vench.fr/vente-166405-juigne-des-moutiers.html",
        title: "Maison d habitation Juigné-des-Moutiers",
        propertyType: "house",
        city: "Juigné-des-Moutiers",
        saleDate: "2026-10-16T00:00:00.000Z",
        startingPriceEur: 100_000,
      }),
      dedupeSale({
        id: "licitor-110008",
        sourceName: "licitor",
        externalId: "110008",
        sourceUrl: "https://www.licitor.com/annonce/juigne-des-moutiers/110008.html",
        title: "Maison",
        propertyType: "house",
        city: "Juigné-des-Moutiers",
        saleDate: "2026-10-16T00:00:00.000Z",
        startingPriceEur: 100_000,
        lotNumber: "multi:50000|4 rue lavoir||100000|6 rue lavoir",
      }),
    ];

    const deduplicated = deduplicateTribunalListingSales(rows);

    expect(deduplicated.sales).toHaveLength(2);
    expect(deduplicated.sales.map((sale) => sale.sourceNames).sort()).toEqual([
      ["licitor"],
      ["petites_affiches", "vench"],
    ]);
  });

  it("n’utilise pas une surface inconnue comme pont entre deux surfaces contradictoires", () => {
    const rows = [
      dedupeSale({
        id: "surface-100-pa",
        sourceName: "petites_affiches",
        externalId: "surface-bridge-1",
        sourceUrl: "https://www.petitesaffiches.fr/annonce/surface-bridge-1",
        title: "Appartement",
        propertyType: "apartment",
        city: "Saint-Étienne",
        startingPriceEur: 50_000,
        valuationSource: { app_surface_m2: 100 },
      }),
      dedupeSale({
        id: "surface-unknown-vench",
        sourceName: "vench",
        externalId: "surface-bridge-1",
        sourceUrl: "https://www.vench.fr/vente-surface-bridge-1",
        title: "Appartement",
        propertyType: "apartment",
        city: "Saint-Etienne",
        startingPriceEur: 50_000,
        valuationSource: {},
      }),
      dedupeSale({
        id: "surface-200-licitor",
        sourceName: "petites_affiches",
        externalId: "surface-bridge-1",
        sourceUrl: "https://www.petitesaffiches.fr/annonce/surface-bridge-1-alt",
        title: "Appartement",
        propertyType: "apartment",
        city: "Saint-Étienne",
        startingPriceEur: 50_000,
        valuationSource: { app_surface_m2: 200 },
      }),
    ];

    const deduplicated = deduplicateTribunalListingSales(rows);

    expect(deduplicated.sales).toHaveLength(2);
    expect(deduplicated.sales.map((sale) => sale.sourceNames).sort()).toEqual([
      ["petites_affiches"],
      ["petites_affiches", "vench"],
    ]);
  });

  it("extrait les adresses numérotées des blocs source sans prendre un prix pour une adresse", () => {
    expect(
      extractTribunalIdentityAddress(
        {
          source_blocks: {
            page_text: "Adresse\n18 rue de Richebourg\n44000 Nantes\nMise à prix : 70 000 €",
          },
        },
        "vench",
      ),
    ).toBe("18 rue de Richebourg");
    expect(
      extractTribunalIdentityAddress(
        { source_blocks: { page_text: "Adresse\n3 Rue des Verriers\nSaint-Etienne\nVisites" } },
        "vench",
      ),
    ).toBe("3 Rue des Verriers");
    expect(
      extractTribunalIdentityAddress(
        { source_blocks: { adresse: "18, rue de Richebourg, 44100 Nantes" } },
        "licitor",
      ),
    ).toBe("18, rue de Richebourg");
    expect(
      extractTribunalIdentityAddress(
        {
          source_blocks: {
            page_text: "Adresse du bien\n21 rue Jules Ferry\n42800 RIVE-DE-GIER",
          },
        },
        "encheres_immobilieres",
      ),
    ).toBe("21 rue Jules Ferry");
    expect(
      extractTribunalIdentityAddress(
        { source_blocks: { page_text: "Adresse du bien\n21 rue Jules Ferry\nRive-de-Gier" } },
        "vench",
      ),
    ).toBe("21 rue Jules Ferry");
    expect(
      extractTribunalIdentityAddress(
        {
          source_description: "À SURY LE COMTAL (42), 611 route de Sanzieux",
          source_blocks: { adresse: "50 000 €" },
        },
        "encheres_immobilieres",
      ),
    ).toBe("611 route de Sanzieux");
    expect(
      extractTribunalIdentityAddress(
        {
          source_blocks: {
            description: "Le bien est situé 3 Rue des Verriers, cadastré section LO.",
          },
        },
        "vench",
      ),
    ).toBe("3 Rue des Verriers");
    expect(
      extractTribunalIdentityAddress(
        { source_blocks: { page_text: "Adresse\nNantes\nAvocat : 4 rue du Palais" } },
        "vench",
      ),
    ).toBeNull();
    expect(
      extractTribunalIdentityAddress(
        {
          source_blocks: {
            page_text: "Adresse de l’avocat\n4 rue du Palais\nAdresse du bien\nNantes",
          },
        },
        "vench",
      ),
    ).toBeNull();
  });

  it("déduplique deux sources quand leurs adresses source précises concordent", () => {
    const deduplicated = deduplicateTribunalListingSales([
      dedupeSale({
        id: "vench-166155",
        sourceName: "vench",
        externalId: "166155",
        sourceUrl: "https://www.vench.fr/vente-166155-local-nantes.html",
        title: "Local commercial",
        propertyType: "other",
        city: "Nantes",
        address: null,
        identityAddress: "18 rue de Richebourg, 44000 Nantes",
        saleDate: "2026-10-16T00:00:00.000Z",
        startingPriceEur: 70_000,
      }),
      dedupeSale({
        id: "licitor-109826",
        sourceName: "licitor",
        externalId: "109826",
        sourceUrl: "https://www.licitor.com/annonce/nantes/109826.html",
        title: "Local commercial",
        propertyType: "other",
        city: "Nantes",
        address: null,
        identityAddress: "18,rueRichebourg44100Nantes",
        saleDate: "2026-10-16T12:00:00.000Z",
        startingPriceEur: 70_000,
      }),
    ]);

    expect(deduplicated.sales).toHaveLength(1);
    expect(deduplicated.sales[0]?.sourceNames).toEqual(["licitor", "vench"]);

    const compactAddressMatch = deduplicateTribunalListingSales([
      dedupeSale({
        id: "vench-165890",
        sourceName: "vench",
        externalId: "165890",
        identityAddress: "3 Rue des Verriers",
        city: "Saint-Étienne",
        saleDate: "2026-10-15T00:00:00.000Z",
        startingPriceEur: 12_000,
      }),
      dedupeSale({
        id: "licitor-109914",
        sourceName: "licitor",
        externalId: "109914",
        identityAddress: "3,rueVerriers42000SaintEtienne",
        city: "Saint-Etienne",
        saleDate: "2026-10-15T12:00:00.000Z",
        startingPriceEur: 12_000,
      }),
    ]);
    expect(compactAddressMatch.sales).toHaveLength(1);
  });

  it("extrait les références juridiques attribuées et ne prend pas un prix pour une référence", () => {
    expect(
      extractTribunalLegalReference(
        { source_blocks: { page_text: "Appartement · Ref. : 26/28 · 5 novembre 2026" } },
        "petites_affiches",
      ),
    ).toBe("26/28");
    expect(
      extractTribunalLegalReference(
        { source_blocks: { page_text: "RG n° 26/00035 · Mise à prix : 50 000 €" } },
        "encheres_immobilieres",
      ),
    ).toBe("26/35");
    expect(
      extractTribunalLegalReference(
        { source_blocks: { page_text: "Mise à prix : 50 000 € · 26/00035" } },
        "encheres_immobilieres",
      ),
    ).toBeNull();
    expect(
      extractTribunalLegalReference({ source_blocks: { reference: "166565" } }, "petites_affiches"),
    ).toBeNull();
  });

  it("relie les avis PA et Enchères par référence juridique avec les garde-fous réels", () => {
    const rows = [
      dedupeSale({
        id: "pa-166565",
        sourceName: "petites_affiches",
        externalId: "166565",
        title: "Appartement 8 000 € · Ref. 26/28",
        propertyType: "apartment",
        city: "Saint-Étienne",
        saleDate: "2026-11-05T09:00:00.000Z",
        startingPriceEur: 8_000,
        legalReference: "26/28",
      }),
      dedupeSale({
        id: "ench-9555",
        sourceName: "encheres_immobilieres",
        externalId: "9555",
        title: "Appartement · RG 26/00028",
        propertyType: "apartment",
        city: "Saint-Etienne",
        saleDate: "2026-11-05T12:00:00.000Z",
        startingPriceEur: 8_000,
        legalReference: "26/28",
      }),
      dedupeSale({
        id: "pa-166567",
        sourceName: "petites_affiches",
        externalId: "166567",
        title: "Bien à Rive-de-Gier · Ref. 26/00035",
        propertyType: "other",
        city: "Rive-de-Gier",
        saleDate: "2026-11-19T09:00:00.000Z",
        startingPriceEur: 50_000,
        legalReference: "26/35",
      }),
      dedupeSale({
        id: "ench-9563",
        sourceName: "encheres_immobilieres",
        externalId: "9563",
        title: "Bien à Rive-de-Gier · RG 26/00035",
        propertyType: "other",
        city: "Rive-de-Gier",
        saleDate: "2026-11-19T12:00:00.000Z",
        startingPriceEur: 50_000,
        legalReference: "26/00035",
      }),
    ];

    const deduplicated = deduplicateTribunalListingSales(rows);

    expect(deduplicated.sales).toHaveLength(2);
    expect(deduplicated.sales.map((sale) => sale.sourceNames).sort()).toEqual([
      ["encheres_immobilieres", "petites_affiches"],
      ["encheres_immobilieres", "petites_affiches"],
    ]);
  });

  it("rattache Enchères à un groupe PA/Vench par l’ancre juridique, sans relâcher les garde-fous", () => {
    const pa = dedupeSale({
      id: "pa-166565-with-vench",
      sourceName: "petites_affiches",
      externalId: "166565",
      propertyType: "apartment",
      city: "Saint-Étienne",
      saleDate: "2026-11-05T09:00:00.000Z",
      startingPriceEur: 8_000,
      legalReference: "26/28",
    });
    const vench = dedupeSale({
      id: "vench-166565-with-pa",
      sourceName: "vench",
      externalId: "166565",
      propertyType: "apartment",
      city: "Saint-Etienne",
      saleDate: "2026-11-05T12:00:00.000Z",
      startingPriceEur: 8_000,
    });
    const ench = dedupeSale({
      id: "ench-9555-with-pa-vench",
      sourceName: "encheres_immobilieres",
      externalId: "9555",
      propertyType: "apartment",
      city: "Saint-Etienne",
      saleDate: "2026-11-05T14:00:00.000Z",
      startingPriceEur: 8_000,
      legalReference: "26/00028",
    });

    const deduplicated = deduplicateTribunalListingSales([pa, vench, ench]);

    expect(deduplicated.sales).toHaveLength(1);
    expect(deduplicated.sales[0]?.sourceNames).toEqual([
      "encheres_immobilieres",
      "petites_affiches",
      "vench",
    ]);

    const contradictoryEnch = dedupeSale({
      ...ench,
      id: "ench-9555-price-conflict",
      startingPriceEur: 9_000,
    });
    const refused = deduplicateTribunalListingSales([pa, vench, contradictoryEnch]);
    expect(refused.sales).toHaveLength(2);
    expect(refused.sales.map((sale) => sale.sourceNames).sort()).toEqual([
      ["encheres_immobilieres"],
      ["petites_affiches", "vench"],
    ]);
  });

  it("refuse la fusion par référence si la date d’audience ou la mise à prix diffère", () => {
    const base = dedupeSale({
      id: "pa-reference-guard",
      sourceName: "petites_affiches",
      externalId: "166567",
      propertyType: "other",
      city: "Rive-de-Gier",
      saleDate: "2026-11-19T09:00:00.000Z",
      startingPriceEur: 50_000,
      legalReference: "26/35",
    });
    const dateMismatch = dedupeSale({
      ...base,
      id: "ench-reference-date-mismatch",
      sourceName: "encheres_immobilieres",
      externalId: "9557",
      saleDate: "2026-11-20T09:00:00.000Z",
      legalReference: "26/35",
    });
    const priceMismatch = dedupeSale({
      ...base,
      id: "ench-reference-price-mismatch",
      sourceName: "encheres_immobilieres",
      externalId: "9558",
      startingPriceEur: 55_000,
      legalReference: "26/35",
    });

    expect(deduplicateTribunalListingSales([base, dateMismatch]).sales).toHaveLength(2);
    expect(deduplicateTribunalListingSales([base, priceMismatch]).sales).toHaveLength(2);
  });
});

function dedupeSale(overrides: Partial<DeduplicationSale>): DeduplicationSale {
  const sourceName = overrides.sourceName ?? "petites_affiches";
  const sourceUrl = overrides.sourceUrl ?? `https://${sourceName}.example.test/annonce/demo`;
  return {
    id: "00000000-0000-4000-8000-000000000000",
    tribunal: "TJ Saint-Etienne",
    title: "Annonce",
    city: "Saint-Étienne",
    address: null,
    sourceName,
    sourceNames: [sourceName],
    sourceUrls: [sourceUrl],
    sourceUrl,
    externalId: null,
    contentHash: null,
    identityAddress: null,
    legalReference: null,
    lotNumber: null,
    saleDate: "2026-10-15T00:00:00.000Z",
    status: "upcoming",
    startingPriceEur: 3_000,
    propertyType: "other",
    visitDates: [],
    occupancyStatus: null,
    lawyerName: null,
    publicationAt: null,
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    overbidStatus: null,
    overbidEvidence: [],
    marketEstimate: null,
    marketEstimateEligible: false,
    valuationSource: {},
    ...overrides,
  } as DeduplicationSale;
}

function saleRow(id: string, sourceName: string) {
  return {
    id,
    source_name: sourceName,
    source_url: `https://${sourceName}.example.test/annonce/${id}`,
    source_urls: [],
    external_id: id,
    tribunal: "TJ Saint-Etienne",
    tribunal_code: "justice_tj_1_112",
    sale_venue_type: "tribunal",
    sale_verification_status: "verified",
    status: "past",
    sale_date: "2026-06-10T09:00:00.000Z",
    starting_price_eur: 50_000,
    property_type: "apartment",
    visit_dates: [],
    occupancy_status: "vacant",
    city: "Saint-Étienne",
    address: "12 rue de la Paix",
    postal_code: "42000",
    lawyer_name: "Cabinet Test",
    title: "Appartement",
    first_seen_at: "2026-06-01T09:00:00.000Z",
    raw_payload: {},
    latitude: null,
    longitude: null,
    app_surface_m2: 60,
    habitable_surface_m2: null,
    carrez_surface_m2: 60,
    land_surface_m2: null,
    app_surface_kind: "carrez",
    surface_scope: "total",
    rooms_count: 3,
    bedrooms_count: 2,
    updated_at: "2026-06-01T09:00:00.000Z",
    publication_quarantine: null,
  };
}

function fakeQuery(result: { data: unknown; error: { message: string } | null }) {
  const state: {
    selected: string;
    filters: Array<[string, string, unknown]>;
    orders: Array<[string, { ascending?: boolean } | undefined]>;
    ranges: Array<[number, number]>;
  } = { selected: "", filters: [], orders: [], ranges: [] };
  const query: Record<string, unknown> = {};
  query.select = vi.fn((columns: string) => {
    state.selected = columns;
    return query;
  });
  for (const method of ["eq", "in", "is"] as const) {
    query[method] = vi.fn((column: string, value: unknown) => {
      state.filters.push([method, column, value]);
      return query;
    });
  }
  query.order = vi.fn((column: string, options?: { ascending?: boolean }) => {
    state.orders.push([column, options]);
    return query;
  });
  query.limit = vi.fn(() => query);
  query.range = vi.fn(async (from: number, to: number) => {
    state.ranges.push([from, to]);
    return result;
  });
  query.maybeSingle = vi.fn(async () => result);
  query.then = (
    resolve: (value: typeof result) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return { query, state };
}
