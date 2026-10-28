import { describe, expect, it } from "vitest";
import { parseCreateTable, readTableSchema, validateUpsert } from "./fake-postgrest";

const flood = readTableSchema("20261106100200_sale_flood_risk.sql", "auction_sale_flood_risk");
const known = {
  sale_id: "11111111-1111-4111-8111-111111111111",
  verdict: "none_found",
  derive_version: "v1",
  position_key: "abc",
  position_kind: "point",
  observed_at: "2026-10-01T00:00:00Z",
};

describe("lecture du schéma dans la migration", () => {
  it("lit les colonnes NOT NULL, les valeurs par défaut et la clé primaire", () => {
    expect(flood.primaryKey).toEqual(["sale_id"]);
    expect(flood.columns.get("verdict")).toMatchObject({ notNull: true, hasDefault: false });
    expect(flood.columns.get("tri_scenarios")).toMatchObject({ notNull: true, hasDefault: true });
    expect(flood.columns.get("map_date")).toMatchObject({ notNull: false, hasDefault: false });
    expect([...flood.columns.keys()]).toContain("last_failure");
    expect(flood.checks.map((check) => check.name)).toContain(
      "auction_sale_flood_risk_known_requires_observation",
    );
  });

  it("lit une table écrite à la main, virgules et parenthèses imbriquées comprises", () => {
    const schema = parseCreateTable(
      `create table public.demo (
        id integer,
        label text not null default 'a, b',
        code text check (code in ('x', 'y')),
        primary key (id)
      );`,
      "demo",
    );
    expect(schema.primaryKey).toEqual(["id"]);
    expect(schema.columns.get("id")?.notNull).toBe(true);
    expect(schema.columns.get("label")).toMatchObject({ notNull: true, hasDefault: true });
    expect(schema.checks[0].expression).toBe("code in ('x', 'y')");
  });
});

describe("validateUpsert", () => {
  it("accepte une ligne complète", () => {
    expect(validateUpsert(flood, [known])).toBeNull();
  });

  it("refuse en 23502 une colonne NOT NULL à défaut absente d'une ligne de l'envoi (missing=null)", () => {
    const rows = [{ ...known, ppri_checked: true }, { ...known, sale_id: "other" }];
    expect(validateUpsert(flood, rows)?.code).toBe("23502");
    // `defaultToNull: false` (Prefer: missing=default) : la valeur par défaut s'applique.
    expect(validateUpsert(flood, rows, { defaultToNull: false })).toBeNull();
  });

  it("refuse une colonne NOT NULL sans défaut, même avec missing=default", () => {
    const { derive_version: _omitted, ...incomplete } = known;
    const rows = [known, incomplete];
    expect(validateUpsert(flood, rows, { defaultToNull: false })?.code).toBe("23502");
  });

  it("refuse en 23514 un CHECK : code d'échec, verdict, observation manquante", () => {
    expect(validateUpsert(flood, [{ ...known, last_failure: "HTTP 503!" }])?.code).toBe("23514");
    expect(validateUpsert(flood, [{ ...known, last_failure: "http_503" }])).toBeNull();
    expect(validateUpsert(flood, [{ ...known, verdict: "safe" }])?.code).toBe("23514");
    expect(validateUpsert(flood, [{ ...known, observed_at: null }])?.code).toBe("23514");
    expect(validateUpsert(flood, [{ ...known, verdict: "unknown", observed_at: null }])).toBeNull();
    expect(validateUpsert(flood, [{ ...known, failure_count: -1 }])?.code).toBe("23514");
    expect(validateUpsert(flood, [{ ...known, commune_insee: "ab" }])?.code).toBe("23514");
    expect(validateUpsert(flood, [{ ...known, commune_insee: "2A004" }])).toBeNull();
  });

  it("refuse en 21000 deux lignes de même clé dans un envoi", () => {
    expect(validateUpsert(flood, [known, known])).toMatchObject({ code: "21000" });
    expect(validateUpsert(flood, [known, { ...known, sale_id: "other" }])).toBeNull();
  });

  it("refuse une colonne qui n'existe pas", () => {
    expect(validateUpsert(flood, [{ ...known, nom_inconnu: 1 }])?.code).toBe("PGRST204");
  });
});
