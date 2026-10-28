import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { readSaleCommunes } from "@/lib/flood-risk-store.server";
import { isMissingDatabaseObject } from "@/lib/postgrest-errors";

/**
 * Recopie le code commune que le pipeline pose sur chaque vente (`raw_payload.commune`, voir
 * `services/data-pipeline/src/commune_insee.py`) dans la table `auction_sale_communes`, qui sert de référence aux
 * lectures SQL (contrôle d'inondation, loyers). Seules les ventes dont le code a changé ou qui n'ont pas encore de
 * ligne sont écrites. Les ventes déjà présentes à la pose de la migration ont été remplies par SQL
 * (`20261106100100_auction_sale_communes_backfill.sql`).
 *
 * Aucune coordonnée, aucune adresse : un code commune, un code d'arrondissement et la provenance.
 */

const PAGE_SIZE = 1000;
const MAX_ROWS = 20_000;
const WRITE_CHUNK = 200;
const CODE_PATTERN = /^[0-9][0-9AB][0-9]{3}$/;
const SOURCES = ["geocode", "reference_communes"] as const;
/**
 * Arrondissements valides par commune : exactement la contrainte `auction_sale_communes_arrondissement_check`
 * de la migration 20261106100000 (Paris, Lyon, Marseille, chacun rattaché à SA commune).
 */
const ARRONDISSEMENT_PATTERNS: Record<string, RegExp> = {
  "75056": /^751(0[1-9]|1[0-9]|20)$/,
  "13055": /^132(0[1-9]|1[0-6])$/,
  "69123": /^6938[1-9]$/,
};

export type SaleCommuneSyncResult = {
  /** Ventes lues avec un code commune posé par le pipeline. */
  withCode: number;
  /** Lignes écrites (nouvelles ou modifiées). */
  written: number;
  /** Lignes que la base a refusées (une ligne invalide est ignorée, la passe continue). */
  rejected: number;
  /** La table n'existe pas encore (migration non appliquée). */
  notMigrated: boolean;
};

type PipelineCommune = {
  insee: string;
  arrondissementInsee: string | null;
  source: (typeof SOURCES)[number];
};

/** `raw_payload.commune` du pipeline, ou `null` s'il est absent ou illisible. */
export function pipelineCommuneOf(value: unknown): PipelineCommune | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const insee = typeof record.insee === "string" ? record.insee.trim().toUpperCase() : "";
  if (!CODE_PATTERN.test(insee)) return null;
  const arrondissementRaw =
    typeof record.arrondissement_insee === "string"
      ? record.arrondissement_insee.trim().toUpperCase()
      : "";
  const source = SOURCES.find((candidate) => candidate === record.source);
  if (!source) return null;
  // La paire commune + arrondissement est validée comme la contrainte SQL ; sinon, pas d'arrondissement (la
  // commune seule reste utile, et la ligne ne sera pas refusée par la base).
  const arrondissementPattern = ARRONDISSEMENT_PATTERNS[insee];
  return {
    insee,
    arrondissementInsee:
      arrondissementPattern && arrondissementPattern.test(arrondissementRaw)
        ? arrondissementRaw
        : null,
    source,
  };
}

export async function syncSaleCommunes(now: Date = new Date()): Promise<SaleCommuneSyncResult> {
  const result: SaleCommuneSyncResult = {
    withCode: 0,
    written: 0,
    rejected: 0,
    notMigrated: false,
  };
  const stored = await readSaleCommunes();
  if (stored == null) return { ...result, notMigrated: true };

  const pending: Array<{
    sale_id: string;
    commune_insee: string;
    arrondissement_insee: string | null;
    source: string;
    resolved_at: string;
  }> = [];
  let exhausted = false;
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("auction_sales")
      .select("id, commune:raw_payload->commune")
      .eq("status", "upcoming")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      const commune = pipelineCommuneOf(row.commune);
      if (!commune) continue;
      result.withCode += 1;
      const current = stored.get(row.id);
      if (
        current &&
        current.communeInsee === commune.insee &&
        current.arrondissementInsee === commune.arrondissementInsee
      ) {
        continue;
      }
      pending.push({
        sale_id: row.id,
        commune_insee: commune.insee,
        arrondissement_insee: commune.arrondissementInsee,
        source: commune.source,
        resolved_at: now.toISOString(),
      });
    }
    if ((data?.length ?? 0) < PAGE_SIZE) {
      exhausted = true;
      break;
    }
  }
  // Comme les lectures de flood-risk-store : une borne atteinte n'est pas une fin de liste, sinon les
  // ventes au-delà ne recevraient jamais de commune, sans que personne ne le sache.
  if (!exhausted) throw new Error("Trop de ventes à rattacher à une commune.");

  for (let index = 0; index < pending.length; index += WRITE_CHUNK) {
    const chunk = pending.slice(index, index + WRITE_CHUNK);
    try {
      const { error } = await supabaseAdmin
        .from("auction_sale_communes")
        .upsert(chunk, { onConflict: "sale_id" });
      if (!error) {
        result.written += chunk.length;
        continue;
      }
      if (isMissingDatabaseObject(error)) return { ...result, notMigrated: true };
    } catch {
      // Le paquet entier est refusé : on retente ligne par ligne ci-dessous.
    }
    // Une ligne invalide ne doit pas annuler la passe : chaque ligne du paquet refusé est retentée seule.
    for (const row of chunk) {
      try {
        const { error } = await supabaseAdmin
          .from("auction_sale_communes")
          .upsert(row, { onConflict: "sale_id" });
        if (error) {
          if (isMissingDatabaseObject(error)) return { ...result, notMigrated: true };
          result.rejected += 1;
        } else {
          result.written += 1;
        }
      } catch {
        result.rejected += 1;
      }
    }
  }
  return result;
}
