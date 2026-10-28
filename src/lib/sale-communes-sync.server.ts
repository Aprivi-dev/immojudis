import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isMissingDatabaseObject } from "@/lib/flood-risk-store.server";
import { isBusyWriteError } from "@/lib/write-busy";

/**
 * Recopie le code commune que le pipeline pose sur chaque vente (`raw_payload.commune`, voir
 * `services/data-pipeline/src/commune_insee.py`) dans la table `auction_sale_communes`, qui sert de référence aux
 * lectures SQL (contrôle d'inondation, loyers). Seules les ventes dont le code a changé ou qui n'ont pas encore de
 * ligne sont écrites. Les ventes déjà présentes à la pose de la migration ont été remplies par SQL
 * (`20261106100100_auction_sale_communes_backfill.sql`).
 *
 * Tout se passe DANS la base, en une instruction : la fonction `sync_sale_communes()` (migration 20261108110100, rôle
 * de service) lit `raw_payload->commune` des ventes à venir, applique les règles de `pipelineCommuneOf` ci-dessous
 * (que la fonction reproduit et que les tests de ce fichier et `771_sync_sale_communes.sql` figent), compare au
 * stocké et n'écrit que les lignes nouvelles ou modifiées. Avant, la passe relisait chaque heure le `raw_payload` de
 * toutes les ventes à venir (plusieurs Mo décompressés) pour comparer en JavaScript. Les ventes verrouillées en
 * écriture par une autre transaction sont sautées sans attente et reprises à la passe suivante.
 *
 * Aucune coordonnée, aucune adresse : un code commune, un code d'arrondissement et la provenance.
 */

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
  /** Ventes à venir avec un code commune posé par le pipeline. */
  withCode: number;
  /** Lignes écrites (nouvelles ou modifiées). */
  written: number;
  /**
   * Lignes à écrire mais sautées car la vente était verrouillée en écriture par une autre transaction : reprises à la
   * passe suivante.
   */
  deferred: number;
  /** Toujours 0 : la fonction SQL applique les contraintes de la table, elle ne produit pas de ligne refusée. */
  rejected: number;
  /** La synchronisation n'a pas pu s'exécuter (base occupée, délai dépassé) : elle reprend à la passe suivante. */
  busy: boolean;
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

type SyncRow = { n_with_code: number; n_changed: number; n_written: number };

/**
 * Lance la recopie. Avant la migration 20261108110100 (fonction absente), elle est sautée sans erreur tant que la table
 * est lisible : les codes posés par le remplissage initial restent utilisables. `now` n'est plus utilisé : la date de
 * pose est celle de la base.
 */
export async function syncSaleCommunes(_now: Date = new Date()): Promise<SaleCommuneSyncResult> {
  const result: SaleCommuneSyncResult = {
    withCode: 0,
    written: 0,
    deferred: 0,
    rejected: 0,
    busy: false,
    notMigrated: false,
  };
  const { data, error } = await supabaseAdmin.rpc("sync_sale_communes");
  if (error) {
    if (isMissingDatabaseObject(error)) {
      const probe = await supabaseAdmin.from("auction_sale_communes").select("sale_id").limit(1);
      if (probe.error) {
        if (isMissingDatabaseObject(probe.error)) return { ...result, notMigrated: true };
        throw new Error(
          `Lecture des communes de ventes refusée (code ${probe.error.code ?? "inconnu"})`,
        );
      }
      return result;
    }
    // Verrou ou délai dépassé : ce n'est pas une panne, la recopie reprend à la passe suivante.
    if (isBusyWriteError(error)) return { ...result, busy: true };
    // Le message d'erreur peut citer une ligne : seul le code remonte.
    throw new Error(`Synchronisation des communes refusée (code ${error.code ?? "inconnu"})`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as SyncRow | null | undefined;
  if (!row) return result;
  const written = Number(row.n_written) || 0;
  return {
    ...result,
    withCode: Number(row.n_with_code) || 0,
    written,
    deferred: Math.max(0, (Number(row.n_changed) || 0) - written),
  };
}
