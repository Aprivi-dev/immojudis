import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RPC_LIMITS } from "./preview-search-request";

/**
 * `RPC_LIMITS` recopie les bornes que la fonction SQL de recherche publique contrôle (au-delà, elle
 * lève 22023 et la route répondrait 503 au lieu de 400). Ce test relit la migration qui définit la
 * fonction et compare ses bornes : si l'une change d'un côté seulement, il échoue.
 */
const MIGRATIONS = path.join(process.cwd(), "supabase", "migrations");
const VALIDATION_MESSAGE = "Invalid or oversized preview search parameters.";
const LAST_DEFINITION = "20261024100000_listing_completeness_ranking.sql";

const migrationNames = () =>
  readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
const read = (name: string) => readFileSync(path.join(MIGRATIONS, name), "utf8");

/** Bloc de validation de `app_private.search_auction_sales_preview_v<version>`. */
function validationBlock(source: string, version: 3 | 4): string {
  const start = source.indexOf(
    `create function app_private.search_auction_sales_preview_v${version}(`,
  );
  expect(start, `v${version} introuvable`).toBeGreaterThan(-1);
  const end = source.indexOf(VALIDATION_MESSAGE, start);
  expect(end, `validation de v${version} introuvable`).toBeGreaterThan(start);
  return source.slice(source.indexOf("begin", start), end);
}

const numbers = (block: string, pattern: RegExp) =>
  [...block.matchAll(pattern)].map((match) => Number(match[1]));

describe("bornes de la fonction SQL de recherche publique", () => {
  it("la dernière définition de la validation est celle de 20261024100000", () => {
    // Une migration plus récente qui réécrirait ces bornes doit être lue à sa place : on le fait
    // échouer ici plutôt que de comparer en silence à une définition périmée. 20261027100200
    // réécrit le corps des fonctions de recherche (visibilité sans raw_payload) en relisant leur
    // définition en base (pg_get_functiondef) : les bornes sont conservées et le message de
    // validation n'apparaît pas dans son texte.
    const names = migrationNames();
    const defining = names.filter((name) => read(name).includes(VALIDATION_MESSAGE));
    expect(defining.at(-1)).toBe(LAST_DEFINITION);
    const rewrite = names.find((name) => name.startsWith("20261027100200_"));
    expect(rewrite).toBeDefined();
    expect(read(rewrite!)).toContain("search_auction_sales_preview_v3");
    expect(read(rewrite!)).not.toContain(VALIDATION_MESSAGE);
  });

  it.each([3, 4] as const)(
    "v%i : les bornes de la migration sont celles de RPC_LIMITS",
    (version) => {
      const block = validationBlock(read(LAST_DEFINITION), version);

      // Nombre d'éléments : départements, mots-clés, types de bien, statuts.
      expect(numbers(block, /cardinality\(p_\w+\), 0\) > (\d+)/g)).toEqual([
        RPC_LIMITS.departments,
        RPC_LIMITS.keywords,
        RPC_LIMITS.propertyTypes,
        RPC_LIMITS.statuses,
      ]);

      // Longueur d'un élément : départements, mots-clés, types de bien, puis statuts.
      expect(
        numbers(
          block,
          /max\(length\(item\.value\)\) from unnest\(p_\w+\) as item\(value\)\), 0\) > (\d+)/g,
        ),
      ).toEqual([
        RPC_LIMITS.listItemLength,
        RPC_LIMITS.listItemLength,
        RPC_LIMITS.listItemLength,
        RPC_LIMITS.statusLength,
      ]);

      const scalar = (name: string) =>
        numbers(block, new RegExp(`length\\(coalesce\\(${name}, ''\\)\\) > (\\d+)`, "g"));
      expect(scalar("p_city")).toEqual([RPC_LIMITS.city]);
      expect(scalar("p_postal_code")).toEqual([RPC_LIMITS.postalCode]);
      expect(scalar("p_tribunal")).toEqual([RPC_LIMITS.tribunal]);
      expect(scalar("p_sort")).toEqual([RPC_LIMITS.sort]);

      expect(numbers(block, /coalesce\(p_limit, \d+\) < (\d+)/g)).toEqual([1]);
      expect(numbers(block, /coalesce\(p_limit, \d+\) > (\d+)/g)).toEqual([RPC_LIMITS.maxLimit]);
      expect(numbers(block, /coalesce\(p_offset, \d+\) < (\d+)/g)).toEqual([0]);
      expect(numbers(block, /coalesce\(p_offset, \d+\) > (\d+)/g)).toEqual([RPC_LIMITS.maxOffset]);
    },
  );
});
