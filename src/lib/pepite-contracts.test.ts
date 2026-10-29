// Contrats entre le code TypeScript et le SQL (ou Python) qui répètent une même valeur sans qu'aucun compilateur ne
// les rapproche (compte-rendu du 27/10/2026, n° 33). TypeScript fait foi pour les seuils : si l'un change, ce test
// échoue et dit quel fichier mettre à jour.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/fee-regime.server", () => ({ openFeeRegimesFromEnv: () => [] }));
vi.mock("@/lib/auction-scenarios.server", () => ({ getAuctionScenarios: async () => null }));
vi.mock("@/lib/sale-market-estimates", () => ({
  SALE_INPUT_SELECT: "id",
  buildSaleValuationInput: () => ({}),
  saleValuationFingerprint: () => "",
  marketContextFromStoredRow: () => ({}),
}));

import { FLOOD_VERDICTS } from "@/lib/flood-risk";
import { parseMarketTrendRow } from "@/lib/pepite-market";
import {
  PEPITE_COURT_REPLACE_BELOW_SALES,
  PEPITE_MARKET_PRICE_PER_M2_MAX,
  PEPITE_MARKET_PRICE_PER_M2_MIN,
  PEPITE_MARKET_PROPERTY_TYPES,
  PEPITE_MARKET_TREND_YEARS,
  PEPITE_MARKET_WINDOW_MONTHS,
  PEPITE_MAX_EVALUATION_AGE_HOURS,
  PEPITE_MIN_NATIONAL_SALES,
  PEPITE_PRICE_COURT_ONLY_FROM_SALES,
  PEPITE_SMOOTHING_WEIGHT_SALES,
  evaluatePepite,
} from "@/lib/pepite-policy";
import { pepiteDetails } from "@/lib/sale-pepites-batch";
import { ARRONDISSEMENT_PATTERNS } from "@/lib/sale-communes-sync.server";
import { MIN_COURT_SAMPLE, MIN_NATIONAL_SAMPLE } from "@/lib/auction-scenarios";
import { pepiteFloodView } from "@/lib/sale-pepite-view";

const root = resolve(__dirname, "../..");
const migrationsDir = resolve(root, "supabase/migrations");
const migrations = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(resolve(migrationsDir, name), "utf8") }));

/** La dernière migration qui (re)définit la fonction : c'est elle qui s'applique. */
function latestDefinition(functionName: string): { name: string; body: string } {
  const header = new RegExp(
    `create or replace function ${functionName.replace(".", "\\.")}\\s*\\(`,
    "i",
  );
  const defining = migrations.filter((migration) => header.test(migration.sql));
  expect(defining.length, `aucune migration ne définit ${functionName}`).toBeGreaterThan(0);
  const last = defining[defining.length - 1];
  const start = last.sql.search(header);
  const open = last.sql.indexOf("$function$", start);
  const close = last.sql.indexOf("$function$", open + 10);
  return { name: last.name, body: last.sql.slice(open, close) };
}

describe("délai de 36 heures de la lecture publique (TypeScript et SQL)", () => {
  it("get_public_sale_pepite ne publie qu'une évaluation de moins de PEPITE_MAX_EVALUATION_AGE_HOURS heures", () => {
    const { name, body } = latestDefinition("app_private.get_public_sale_pepite");
    const hours = [
      ...body.matchAll(/evaluated_at\s*>\s*pg_catalog\.now\(\)\s*-\s*interval '(\d+) hours'/g),
    ];
    expect(hours, `${name} : garde d'âge de l'évaluation introuvable`).toHaveLength(1);
    expect(Number(hours[0][1])).toBe(PEPITE_MAX_EVALUATION_AGE_HOURS);
  });
});

describe("lissage et seuils du calcul des scénarios (TypeScript et SQL)", () => {
  const { name, body } = latestDefinition("app_private.court_auction_scenarios");

  it("reprend dans la base le poids national de 15 ventes, le seuil de 10 ventes du tribunal et le minimum national", () => {
    // Dernière définition à 4 paramètres (celle qui calcule) : la fonction à 3 paramètres n'est qu'un appel.
    const calculating = migrations
      .filter((migration) => migration.sql.includes("'minimum_national_sample'"))
      .map((migration) => migration.sql)
      .join("\n");
    expect(calculating).toContain(`sizes.n_national < ${PEPITE_MIN_NATIONAL_SALES}`);
    expect(calculating).toContain(`sizes.n_court >= ${PEPITE_COURT_REPLACE_BELOW_SALES}`);
    expect(calculating).toContain(`${PEPITE_SMOOTHING_WEIGHT_SALES} *`);
    expect(calculating).toContain(`/ (sizes.n_court + ${PEPITE_SMOOTHING_WEIGHT_SALES})`);
    expect(calculating).toContain(
      `sizes.n_court >= ${PEPITE_PRICE_COURT_ONLY_FROM_SALES} then 'court'`,
    );
    expect(name).toMatch(/\.sql$/);
    expect(body.length).toBeGreaterThan(0);
  });

  it("les constantes des scénarios (application) disent la même chose que celles de la règle", () => {
    expect(MIN_NATIONAL_SAMPLE).toBe(PEPITE_MIN_NATIONAL_SALES);
    expect(MIN_COURT_SAMPLE).toBe(PEPITE_COURT_REPLACE_BELOW_SALES);
  });
});

describe("chemin JSON du verdict d'inondation lu par la liste publique des « zonage à vérifier »", () => {
  const { name, body } = latestDefinition("app_private.list_public_pepite_flood_exposed_ids");
  const match = /details\s*#>>\s*'\{([a-zA-Z_,]+)\}'\s*=\s*'([a-z_]+)'/.exec(body);

  it("la migration lit un chemin et un verdict précis", () => {
    expect(match, `${name} : lecture details #>> '{...}' introuvable`).not.toBeNull();
  });

  it("ce chemin existe dans le détail écrit par le traitement des pépites, et le verdict lu est un verdict connu", () => {
    const [, rawPath, verdict] = match!;
    expect(FLOOD_VERDICTS as readonly string[]).toContain(verdict);

    const evaluation = evaluatePepite(
      {
        regime: "notary_auction",
        upcoming: true,
        startingPriceEur: 80_000,
        estimate: null,
        ceiling: null,
        scenarios: null,
        signals: {
          landOrMixed: false,
          occupancy: "libre",
          degradedCondition: false,
          valuationConflict: false,
          aiBlocked: false,
          verificationConflict: false,
          probableDuplicate: false,
          unqualifiedRisks: false,
        },
        flood: { verdict: "exposed", ppriChecked: true },
      },
      "pepite-v2",
    );
    const details = pepiteDetails(evaluation, {
      flood: {
        verdict: "exposed",
        observedAt: "2026-11-01T00:00:00.000Z",
        mapDate: null,
        ppriChecked: true,
      },
    } as never) as Record<string, unknown>;

    const value = rawPath
      .split(",")
      .reduce<unknown>(
        (node, key) => (node as Record<string, unknown> | undefined)?.[key],
        details,
      );
    expect(value, `le chemin {${rawPath}} n'existe plus dans le détail écrit`).toBe(verdict);
    // Et la fiche lit le même détail : le verdict stocké rend la ligne « exposé ».
    expect(pepiteFloodView(details)?.verdict).toBe("exposed");
  });
});

describe("motifs d'arrondissement : TypeScript, SQL et Python", () => {
  const sql = migrations.find(
    (migration) => migration.name === "20261106100000_auction_sale_communes.sql",
  )!.sql;
  const python = readFileSync(resolve(root, "services/data-pipeline/src/commune_insee.py"), "utf8");

  const sqlPatterns = Object.fromEntries(
    [...sql.matchAll(/commune_insee = '(\d+)' and arrondissement_insee ~ '([^']+)'/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  // Python : `(re.compile(r"…"), "commune")` ; les groupes non capturants `(?:` valent des groupes simples.
  const pythonPatterns = Object.fromEntries(
    [...python.matchAll(/\(re\.compile\(r"(\^[^"]+)"\), "(\d+)"\)/g)].map((m) => [
      m[2],
      m[1].replaceAll("(?:", "("),
    ]),
  );
  const tsPatterns = Object.fromEntries(
    Object.entries(ARRONDISSEMENT_PATTERNS).map(([commune, pattern]) => [commune, pattern.source]),
  );

  it("couvre Paris, Lyon et Marseille aux trois endroits", () => {
    for (const patterns of [tsPatterns, sqlPatterns, pythonPatterns]) {
      expect(Object.keys(patterns).sort()).toEqual(["13055", "69123", "75056"]);
    }
  });

  it("écrit le même motif pour chaque commune en TypeScript, en SQL et en Python", () => {
    expect(sqlPatterns).toEqual(tsPatterns);
    expect(pythonPatterns).toEqual(tsPatterns);
  });
});

describe("marché local de la règle pepite-v1.2 (TypeScript et SQL)", () => {
  const { name, body } = latestDefinition("app_private.refresh_commune_market_trends");
  const typeList = PEPITE_MARKET_PROPERTY_TYPES.map((type) => `'${type}'`).join(", ");

  it("le recalcul de l'agrégat reprend les bornes de prix, la fenêtre, l'écart d'années et les types de la règle", () => {
    expect(body, name).toContain(
      `dvf.price_per_m2 between ${PEPITE_MARKET_PRICE_PER_M2_MIN} and ${PEPITE_MARKET_PRICE_PER_M2_MAX}`,
    );
    expect(body, name).toContain(`interval '${PEPITE_MARKET_WINDOW_MONTHS} months'`);
    expect(body, name).toContain(
      `pg_catalog.make_date(v_year - ${PEPITE_MARKET_TREND_YEARS}, 1, 1)`,
    );
    expect(body, name).toContain(
      `pg_catalog.make_date(v_year - ${PEPITE_MARKET_TREND_YEARS}, 12, 31)`,
    );
    expect(body, name).toContain("dvf.mutation_nature = 'Vente'");
    expect(body, name).toContain(`dvf.property_type in (${typeList})`);
  });

  it("la table n'accepte que les types de logement de la règle", () => {
    const migration = migrations.find((item) => item.name === name)!.sql;
    expect(migration).toContain(`check (property_type in (${typeList}))`);
  });

  it("les colonnes lues par l'application sont celles que la fonction publique rend", () => {
    const { body: reader } = latestDefinition("public.get_commune_market_trends");
    for (const key of [
      "insee_code",
      "property_type",
      "reference_year",
      "sales_12_months",
      "median_recent_eur_m2",
      "median_baseline_eur_m2",
      "sales_recent_year",
      "sales_baseline_year",
    ]) {
      expect(reader, key).toContain(`'${key}'`);
    }
  });

  it("une ligne rendue par la fonction publique est lue par la règle", () => {
    const parsed = parseMarketTrendRow({
      insee_code: "33063",
      property_type: "Maison",
      reference_year: 2026,
      sales_12_months: 41,
      median_recent_eur_m2: 3200.5,
      median_baseline_eur_m2: 3500,
      sales_recent_year: 30,
      sales_baseline_year: 33,
    });
    expect(parsed?.aggregate).toMatchObject({ sales12Months: 41, medianRecentEurM2: 3200.5 });
  });
});
