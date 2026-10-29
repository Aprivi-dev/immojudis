import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { mapDocumentReading } from "@/lib/document-reading";
import { isMissingDatabaseObject } from "@/lib/postgrest-errors";
import { pepiteDpeDiagnostic } from "@/lib/pepite-energy";
import type { PepiteV12Source } from "@/lib/pepite-input";
import {
  dvfInseeCode,
  marketTrendKey,
  parseMarketTrendRow,
  type MarketTrendRow,
} from "@/lib/pepite-market";
import {
  PEPITE_MARKET_PROPERTY_TYPES,
  type PepiteMarketAggregate,
  type PepiteMarketPropertyType,
} from "@/lib/pepite-policy";
import type { RentLookup } from "@/lib/rent-reference";
import type { AuctionSale } from "@/lib/types";

/**
 * Lectures de la règle `pepite-v1.2` et suivantes, pour un lot de ventes (rôle de service, jamais un appel réseau
 * externe) : diagnostics de l'ADEME rapprochés de la vente (`auction_dpe_diagnostics`), lecture des pièces
 * (`auction_document_readings`), code commune (`auction_sale_communes`) et agrégat de marché de la commune
 * (`app_private.commune_market_trends`, par `public.get_commune_market_trends`). Rien d'un avocat, de la publicité
 * ni du score d'investissement.
 *
 * Donnée manquante, pas d'exclusion pour le marché : sans la fonction, sans la table des communes ou sans ligne pour
 * la commune, la vente n'a pas d'agrégat et ses critères de marché sont réussis. Une erreur de lecture, elle, fait
 * échouer le lot (jamais une évaluation sur une lecture ratée : un DPE ou une copropriété en difficulté non lus ne
 * doivent pas passer pour une absence).
 */

const URL_CHUNK = 100;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    result.push(items.slice(index, index + size));
  return result;
}

/** Diagnostics ADEME rapprochés de ces ventes, par `source_url` de la vente. */
async function readDpeDiagnostics(sourceUrls: readonly string[]) {
  const bySource = new Map<string, ReturnType<typeof pepiteDpeDiagnostic>[]>();
  for (const urls of chunks([...new Set(sourceUrls)], URL_CHUNK)) {
    const { data, error } = await supabaseAdmin
      .from("auction_dpe_diagnostics")
      .select("source_url, diagnostic_number, dpe_class, established_at, confidence")
      .in("source_url", urls);
    if (error) throw error;
    for (const row of data ?? []) {
      const list = bySource.get(row.source_url) ?? [];
      list.push(pepiteDpeDiagnostic(row));
      bySource.set(row.source_url, list);
    }
  }
  return bySource;
}

/** Points de la lecture des pièces de ces ventes (lecture terminée seulement), par vente. */
async function readReadingPoints(saleIds: readonly string[]) {
  const bySale = new Map<string, ReturnType<typeof mapDocumentReading>["points"]>();
  if (!saleIds.length) return bySale;
  const { data, error } = await supabaseAdmin
    .from("auction_document_readings")
    .select("sale_id, status, points, documents, generated_at, input_truncated")
    .in("sale_id", [...saleIds]);
  if (error) throw error;
  for (const row of data ?? []) {
    if (row.status !== "completed") continue;
    bySale.set(row.sale_id, mapDocumentReading(row).points);
  }
  return bySale;
}

/** Code DVF de la commune de chaque vente ; vide quand la table des communes n'existe pas encore. */
async function readDvfInseeCodes(saleIds: readonly string[]) {
  const codes = new Map<string, string>();
  if (!saleIds.length) return codes;
  const { data, error } = await supabaseAdmin
    .from("auction_sale_communes")
    .select("sale_id, commune_insee, arrondissement_insee")
    .in("sale_id", [...saleIds]);
  if (error) {
    if (isMissingDatabaseObject(error)) return codes;
    throw error;
  }
  for (const row of data ?? []) {
    const code = dvfInseeCode({
      communeInsee: row.commune_insee,
      arrondissementInsee: row.arrondissement_insee,
    });
    if (code) codes.set(row.sale_id, code);
  }
  return codes;
}

/** Agrégats de marché de ces communes, par `commune|type` ; vide quand la fonction n'existe pas encore. */
async function readMarketAggregates(inseeCodes: readonly string[]) {
  const aggregates = new Map<string, PepiteMarketAggregate>();
  const wanted = [...new Set(inseeCodes)];
  if (!wanted.length) return aggregates;
  const { data, error } = await supabaseAdmin.rpc("get_commune_market_trends", {
    p_insee_codes: wanted,
  });
  if (error) {
    if (isMissingDatabaseObject(error)) return aggregates;
    throw error;
  }
  for (const raw of Array.isArray(data) ? (data as MarketTrendRow[]) : []) {
    const parsed = parseMarketTrendRow(raw);
    if (parsed) aggregates.set(parsed.key, parsed.aggregate);
  }
  return aggregates;
}

/**
 * Les lectures de la règle v1.2 pour un lot de ventes. `listingDpeClass` : `raw_payload.source_energy_diagnostics
 * .dpe_class` de chaque vente (lu avec la ligne de `auction_sales`). `rentLookup` : références de loyer déjà
 * chargées (carte ANIL) ; absentes, les badges n'ont pas de loyer.
 */
export async function readPepiteV12Sources({
  sales,
  listingDpeClass,
  rentLookup,
}: {
  sales: readonly AuctionSale[];
  listingDpeClass: ReadonlyMap<string, unknown>;
  rentLookup: RentLookup | null;
}): Promise<Map<string, PepiteV12Source>> {
  const ids = sales.map((sale) => sale.id);
  const [dpeBySource, pointsBySale, inseeBySale] = await Promise.all([
    readDpeDiagnostics(sales.flatMap((sale) => (sale.source_url ? [sale.source_url] : []))),
    readReadingPoints(ids),
    readDvfInseeCodes(ids),
  ]);
  const aggregates = await readMarketAggregates([...inseeBySale.values()]);

  const result = new Map<string, PepiteV12Source>();
  for (const sale of sales) {
    const insee = inseeBySale.get(sale.id);
    // Les deux types : la règle choisit celui du bien APRÈS l'assainissement de la vente (type corrigé).
    const marketAggregates: Partial<Record<PepiteMarketPropertyType, PepiteMarketAggregate>> = {};
    for (const type of PEPITE_MARKET_PROPERTY_TYPES) {
      const aggregate = insee ? aggregates.get(marketTrendKey(insee, type)) : undefined;
      if (aggregate) marketAggregates[type] = aggregate;
    }
    result.set(sale.id, {
      dpeDiagnostics: (sale.source_url ? dpeBySource.get(sale.source_url) : null) ?? [],
      listingDpeClass: listingDpeClass.get(sale.id) ?? null,
      marketAggregates,
      readingPoints: pointsBySale.get(sale.id) ?? null,
      rent: rentLookup ? rentLookup(sale) : null,
    });
  }
  return result;
}
