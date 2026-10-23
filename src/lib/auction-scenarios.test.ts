import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GOOD_COURT_SAMPLE,
  MIN_COURT_SAMPLE,
  MIN_NATIONAL_SAMPLE,
  STARTING_PRICE_BAND_LABELS,
  STARTING_PRICE_BAND_UPPER_BOUNDS,
  dvfReferenceForType,
  formatDataAsOf,
  formatEuro,
  largestRemainderPercentages,
  mapCourtSummaries,
  mapDvfHistory,
  mapLicitorHistory,
  mapScenarioSet,
  probabilityAtLeast,
  representativeStartingPrice,
  scenarioPropertyGroup,
  startingPriceBand,
  startingPriceBandLabel,
} from "./auction-scenarios";

const RAW_SCENARIOS = {
  band: 2,
  court_sample: 165,
  national_sample: 1098,
  price_scope: "court",
  scenarios: [
    { key: "near_start", low_ratio: 0, high_ratio: 1.1, probability: 0.105 },
    { key: "up_to_1_5", low_ratio: 1.1, high_ratio: 1.5, probability: 0.05 },
    { key: "up_to_2", low_ratio: 1.5, high_ratio: 2, probability: 0.088 },
    { key: "up_to_3", low_ratio: 2, high_ratio: 3, probability: 0.239 },
    { key: "above_3", low_ratio: 3, high_ratio: null, probability: 0.518 },
    { key: "unknown", low_ratio: 9, high_ratio: null, probability: 1 },
  ],
  ratio_quartiles: { q25: 2.04, q50: 3.1, q75: 4.625 },
};

describe("auction scenarios mapping", () => {
  it("keeps the five known scenarios and the court's range", () => {
    const set = mapScenarioSet(RAW_SCENARIOS);
    expect(set?.scenarios.map((scenario) => scenario.key)).toEqual([
      "near_start",
      "up_to_1_5",
      "up_to_2",
      "up_to_3",
      "above_3",
    ]);
    expect(set).toMatchObject({ band: 2, courtSample: 165, priceScope: "court" });
    expect(set?.ratioQuartiles.q50).toBe(3.1);
    expect(probabilityAtLeast(set!.scenarios, 2)).toBeCloseTo(0.757, 3);
  });

  it("returns nothing without scenarios", () => {
    expect(mapScenarioSet(null)).toBeNull();
    expect(mapScenarioSet({ scenarios: [] })).toBeNull();
  });

  it("reads the court history and the official DVF prices", () => {
    const licitor = mapLicitorHistory({
      sample: 480,
      mean_starting_price: 101234,
      mean_hammer_price: 250500,
      at_least_double_rate: 0.5,
      by_year: [
        { year: 2024, sales: 160 },
        { year: 2025, sales: 170 },
      ],
    });
    expect(licitor).toMatchObject({ sample: 480, meanHammerPrice: 250500 });
    expect(licitor?.byYear).toHaveLength(2);
    expect(mapLicitorHistory({ sample: 0 })).toBeNull();

    const dvf = mapDvfHistory({
      sample: 350,
      by_type: [
        { property_type: "apartment", sample: 240, median_price_per_m2: 2160, surface_sample: 230 },
        { property_type: "house", sample: 60, median_price_per_m2: 2400, surface_sample: 4 },
      ],
    });
    expect(dvfReferenceForType(dvf, "apartment")?.medianPricePerM2).toBe(2160);
    expect(dvfReferenceForType(dvf, "house")).toBeNull();
    expect(dvfReferenceForType(dvf, "building")).toBeNull();
  });

  it("lists the courts of the comparison table", () => {
    const courts = mapCourtSummaries([
      {
        court_code: "justice_tj_1_210",
        court_name: "TJ Bobigny",
        licitor: { sample: 442, mean_starting_price: 60000 },
        dvf: null,
      },
      { court_name: "sans code" },
    ]);
    expect(courts).toEqual([
      expect.objectContaining({
        courtCode: "justice_tj_1_210",
        courtName: "TJ Bobigny",
        dvf: null,
      }),
    ]);
  });

  it("rounds amounts to the thousand euros", () => {
    expect(formatEuro(91_870).replace(/\s/g, " ")).toBe("92 000 €");
    expect(formatEuro(null)).toBe("—");
  });
});

describe("effectif minimal et niveau de fiabilité", () => {
  it("lit l'état et le niveau de fiabilité renvoyés par la base", () => {
    const set = mapScenarioSet({
      ...RAW_SCENARIOS,
      status: "ok",
      basis: "court",
      reliability: "good",
    });
    expect(set).toMatchObject({ status: "ok", basis: "court", reliability: "good" });
    const low = mapScenarioSet({
      ...RAW_SCENARIOS,
      court_sample: 4,
      status: "ok",
      basis: "national",
      reliability: "low",
    });
    expect(low).toMatchObject({ basis: "national", reliability: "low", courtSample: 4 });
  });

  it("ne garde aucun chiffre sous 30 ventes nationales comparables, quoi que dise la base", () => {
    const fromStatus = mapScenarioSet({
      status: "insufficient",
      band: 2,
      court_sample: 3,
      national_sample: 18,
    });
    expect(fromStatus).toMatchObject({
      status: "insufficient",
      courtSample: 3,
      nationalSample: 18,
      scenarios: [],
      reliability: null,
      ratioQuartiles: { q25: null, q50: null, q75: null },
    });
    // Une ancienne fonction SQL répondait avec des chiffres dès la première vente.
    const fromOldFunction = mapScenarioSet({ ...RAW_SCENARIOS, national_sample: 29 });
    expect(fromOldFunction).toMatchObject({ status: "insufficient", scenarios: [] });
    expect(mapScenarioSet({ ...RAW_SCENARIOS, national_sample: 30 })).toMatchObject({
      status: "ok",
    });
  });
});

describe("arrondi au plus fort reste", () => {
  it("fait toujours 100, là où l'arrondi de chaque part donne 99 ou 101", () => {
    // 33,4 / 33,3 / 33,3 : 33 + 33 + 33 = 99 arrondis seuls.
    expect(largestRemainderPercentages([0.334, 0.333, 0.333])).toEqual([34, 33, 33]);
    // 12,5 x 8 : arrondis seuls (13 chacun), 104.
    expect(largestRemainderPercentages(Array(8).fill(0.125)).reduce((a, b) => a + b, 0)).toBe(100);
    // La valeur de la fiche de test : 10,5 / 5 / 8,8 / 23,9 / 51,8.
    expect(largestRemainderPercentages([0.105, 0.05, 0.088, 0.239, 0.518])).toEqual([
      10, 5, 9, 24, 52,
    ]);
  });

  it("normalise des parts qui ne font pas tout à fait 1 (quatre décimales en base)", () => {
    const result = largestRemainderPercentages([0.3333, 0.3333, 0.3333, 0, 0]);
    expect(result.reduce((a, b) => a + b, 0)).toBe(100);
    expect(result.slice(3)).toEqual([0, 0]);
  });

  it("ne casse pas sans part", () => {
    expect(largestRemainderPercentages([])).toEqual([]);
    expect(largestRemainderPercentages([0, 0])).toEqual([0, 0]);
  });

  it("somme toujours 100 sur des répartitions quelconques", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let run = 0; run < 200; run += 1) {
      const shares = Array.from({ length: 5 }, () => Math.round(next() * 10_000) / 10_000);
      if (shares.every((share) => share === 0)) continue;
      const result = largestRemainderPercentages(shares);
      expect(result.reduce((a, b) => a + b, 0)).toBe(100);
      for (const value of result) expect(Number.isInteger(value)).toBe(true);
    }
  });
});

describe("date des données", () => {
  it("affiche jour et mois à l'heure de Paris", () => {
    expect(formatDataAsOf("2026-10-22T14:03:00+00:00")).toBe("22/10");
    expect(formatDataAsOf("2026-10-22T23:30:00+00:00")).toBe("23/10");
    expect(formatDataAsOf(null)).toBeNull();
    expect(formatDataAsOf("pas une date")).toBeNull();
  });
});

describe("parité avec le SQL", () => {
  const sql = (name: string) => readFileSync(`supabase/migrations/${name}`, "utf8");

  it("les tranches de mise à prix du TS sont celles de app_private.starting_price_band", () => {
    // La dernière définition fait foi : la migration qui a posé les sept tranches.
    const definition = sql("20261102110000_starting_price_bands_seven.sql");
    const body = definition.slice(
      definition.indexOf("create or replace function app_private.starting_price_band"),
    );
    const bounds = [...body.matchAll(/when p_starting_price < (\d+) then (\d+)/g)].map((match) => ({
      bound: Number(match[1]),
      band: Number(match[2]),
    }));
    expect(bounds.map((item) => item.bound)).toEqual([...STARTING_PRICE_BAND_UPPER_BOUNDS]);
    expect(bounds.map((item) => item.band)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(body).toMatch(/else 7\s+end::smallint/);
    // Une tranche par libellé, sans trou.
    expect(Object.keys(STARTING_PRICE_BAND_LABELS).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Les migrations qui redéfinissent la fonction sont connues : la plus récente fait foi, et une
    // redéfinition plus récente doit venir avec ce test et les constantes.
    const redefining = readdirSync("supabase/migrations")
      .filter((name) => name.endsWith(".sql"))
      .filter((name) =>
        /create\s+(or\s+replace\s+)?function\s+app_private\.starting_price_band/i.test(sql(name)),
      )
      .sort();
    expect(redefining).toEqual([
      "20261019100000_court_auction_scenarios.sql",
      "20261102110000_starting_price_bands_seven.sql",
    ]);
    // Les droits viennent de 20261031100600 et ne sont pas rejoués : « create or replace » les garde.
    expect(sql("20261031100600_grant_starting_price_band.sql")).toMatch(
      /grant execute on function app_private\.starting_price_band\(numeric\) to service_role;/,
    );
    expect(definition).not.toMatch(
      /grant\s+execute\s+on\s+function\s+app_private\.starting_price_band/i,
    );
  });

  it("les seuils de 30 ventes nationales et de 10 ventes du tribunal sont toujours ceux du SQL", () => {
    const definition = sql("20261101120100_auction_scenarios_reliability.sql");
    expect(definition).toMatch(/when sizes\.n_national < 30 then jsonb_build_object\(/);
    expect(definition).toMatch(
      /'basis', case when sizes\.n_court >= 10 then 'court' else 'national' end/,
    );
    expect(definition).toMatch(/when sizes\.n_court >= 30 then 'good'/);
    expect(definition).toMatch(/when sizes\.n_court >= 10 then 'medium'/);
    expect(MIN_NATIONAL_SAMPLE).toBe(30);
    expect(MIN_COURT_SAMPLE).toBe(10);
    expect(GOOD_COURT_SAMPLE).toBe(30);
    // La migration des sept tranches ne redéfinit pas ces fonctions : leur dernière définition reste celle-ci.
    expect(sql("20261102110000_starting_price_bands_seven.sql")).not.toMatch(
      /create\s+(or\s+replace\s+)?function\s+(app_private|public)\.(court_auction_scenarios|get_court_auction_scenarios)/i,
    );
  });

  it("startingPriceBand rend les mêmes tranches, y compris aux bornes", () => {
    const cases: Array<[number | null, number | null]> = [
      [null, null],
      [0, null],
      [-5, null],
      [1, 1],
      [19_999.99, 1],
      [20_000, 2],
      [34_999.99, 2],
      [35_000, 3],
      [49_999, 3],
      [50_000, 4],
      [74_999.99, 4],
      [75_000, 5],
      [99_999, 5],
      [100_000, 6],
      [199_999, 6],
      [200_000, 7],
      [3_000_000, 7],
    ];
    for (const [price, band] of cases) expect(startingPriceBand(price)).toBe(band);
  });

  it("le prix représentatif d'une tranche est dans cette tranche", () => {
    for (const band of [1, 2, 3, 4, 5, 6, 7]) {
      expect(startingPriceBand(representativeStartingPrice(band))).toBe(band);
    }
  });

  it("le libellé d'une tranche est celui de l'écran : « de 20 000 à 35 000 € »…", () => {
    expect(STARTING_PRICE_BAND_LABELS[startingPriceBand(5_000)!]).toBe("inférieures à 20 000 €");
    expect(STARTING_PRICE_BAND_LABELS[startingPriceBand(25_000)!]).toBe("de 20 000 à 35 000 €");
    expect(STARTING_PRICE_BAND_LABELS[startingPriceBand(45_000)!]).toBe("de 35 000 à 50 000 €");
    expect(STARTING_PRICE_BAND_LABELS[startingPriceBand(60_000)!]).toBe("de 50 000 à 75 000 €");
    expect(STARTING_PRICE_BAND_LABELS[startingPriceBand(80_000)!]).toBe("de 75 000 à 100 000 €");
    expect(STARTING_PRICE_BAND_LABELS[startingPriceBand(150_000)!]).toBe("de 100 000 à 200 000 €");
    expect(STARTING_PRICE_BAND_LABELS[startingPriceBand(250_000)!]).toBe("de 200 000 € et plus");
  });

  it("startingPriceBandLabel ne nomme que la tranche du prix de la vente", () => {
    expect(startingPriceBandLabel(3, 45_000)).toBe("de 35 000 à 50 000 €");
    expect(startingPriceBandLabel(7, 250_000)).toBe("de 200 000 € et plus");
    // Base à l'ancienne grille : une autre tranche que celle de la vente, aucun libellé.
    expect(startingPriceBandLabel(2, 45_000)).toBeNull();
    expect(startingPriceBandLabel(5, 45_000)).toBeNull();
    expect(startingPriceBandLabel(null, 45_000)).toBeNull();
    expect(startingPriceBandLabel(3, null)).toBeNull();
    expect(startingPriceBandLabel(3, 0)).toBeNull();
  });

  it("les groupes de nature de bien du TS sont ceux de app_private.scenario_property_group", () => {
    const definition = sql("20261101120100_auction_scenarios_reliability.sql");
    const body = definition.slice(
      definition.indexOf("function app_private.scenario_property_group"),
    );
    const housing = /when p_property_type in \(([^)]*)\) then 'housing'/.exec(body)![1];
    const sqlHousing = [...housing.matchAll(/'(\w+)'/g)].map((match) => match[1]);
    for (const type of sqlHousing) expect(scenarioPropertyGroup(type)).toBe("housing");
    expect(sqlHousing.sort()).toEqual(["apartment", "house", "studio", "villa"]);
    for (const group of ["parking", "land", "commercial"]) {
      expect(body).toContain(`when p_property_type = '${group}' then '${group}'`);
      expect(scenarioPropertyGroup(group)).toBe(group);
    }
    for (const type of ["building", "mixed", "other", "", null, undefined]) {
      expect(scenarioPropertyGroup(type)).toBeNull();
    }
  });
});
