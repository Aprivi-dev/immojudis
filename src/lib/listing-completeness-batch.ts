import "server-only";
import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getListingCompleteness } from "@/lib/listing-completeness";
import {
  COMPLETENESS_TIER_HIGH,
  LISTING_COMPLETENESS_POLICY,
  completenessTierForScore,
} from "@/lib/listing-completeness-ranking";
import { sanitizeAuctionSaleForDisplay } from "@/lib/listing-data-cleanup";
import type { AuctionSale } from "@/lib/types";

/**
 * Évalue la complétude des annonces en ligne et enregistre le palier de classement de /sales
 * (table `auction_sale_listing_completeness`, voir la migration 20261024100000).
 *
 * Le calcul reste en TypeScript : c'est `getListingCompleteness`, le même code que la fiche. La
 * ligne complète est lue avec le rôle de service sur `v_auction_sales_app`, puis nettoyée comme la
 * fiche.
 *
 * Le palier mesure l'information dont Immojudis dispose pour la vente, indépendamment de l'offre
 * de l'utilisateur qui consulte. Une fiche Découverte peut donc en afficher moins que ce que le
 * palier suppose, car une partie (documents, analyse…) est réservée à l'offre Analyse : calculer
 * sur la vue Découverte, qui masque ces champs, donnerait un palier différent selon l'offre et un
 * classement incohérent entre les publics.
 */

const PAGE_SIZE = 1000;
/** Plafond de lecture : au-delà, le catalogue en ligne a changé d'échelle et la tâche doit être revue. */
const MAX_ONLINE_SALES = 20_000;
/** Lignes complètes lues par requête (une ligne pèse plusieurs dizaines de ko). */
const READ_CHUNK_SIZE = 25;
const MAX_REPORTED_ERRORS = 5;
/** Part d'évaluations tentées en échec à partir de laquelle la passe est déclarée en échec. */
export const COMPLETENESS_FAILURE_RATE_THRESHOLD = 0.2;
/**
 * Une évaluation plus ancienne est refaite: la fiche lit aussi des tables liées (documents,
 * présence des sources…) dont un changement ne modifie pas `auction_sales.updated_at`.
 * Capacité: 24 passages par jour x 300 ventes = 7 200 évaluations, pour environ 1 950 ventes en
 * ligne (une réévaluation quotidienne de chacune, plus les nouvelles et les modifiées).
 */
export const LISTING_COMPLETENESS_REFRESH_MS = 24 * 3_600_000;

export type OnlineSale = { id: string; updatedAt: string | null };
export type StoredEvaluation = {
  saleId: string;
  evaluatedAt: string;
  policyVersion: string;
};

export type ListingCompletenessBatchResult = {
  policyVersion: string;
  online: number;
  pending: number;
  evaluated: number;
  highTier: number;
  failed: number;
  remaining: number;
  errors: string[];
};

function time(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Ventes à (ré)évaluer, les plus urgentes d'abord :
 *   1. sans évaluation, les plus récemment modifiées en premier ;
 *   2. évaluées avec une autre version de la règle, les plus anciennes d'abord ;
 *   3. modifiées depuis leur dernière évaluation, les plus anciennes d'abord ;
 *   4. évaluées il y a plus de 24 h (tables liées), les plus anciennes d'abord.
 */
export function pickPendingSales(
  online: OnlineSale[],
  evaluations: StoredEvaluation[],
  policyVersion: string = LISTING_COMPLETENESS_POLICY.version,
  now: Date = new Date(),
): string[] {
  const evaluationBySale = new Map(evaluations.map((row) => [row.saleId, row]));
  const missing: OnlineSale[] = [];
  const outdatedPolicy: Array<{ id: string; evaluatedAt: number }> = [];
  const modified: Array<{ id: string; evaluatedAt: number }> = [];
  const aged: Array<{ id: string; evaluatedAt: number }> = [];

  for (const sale of online) {
    const evaluation = evaluationBySale.get(sale.id);
    if (!evaluation) {
      missing.push(sale);
      continue;
    }
    const evaluatedAt = time(evaluation.evaluatedAt) ?? 0;
    if (evaluation.policyVersion !== policyVersion) {
      outdatedPolicy.push({ id: sale.id, evaluatedAt });
      continue;
    }
    const updatedAt = time(sale.updatedAt);
    if (updatedAt != null && updatedAt > evaluatedAt) {
      modified.push({ id: sale.id, evaluatedAt });
    } else if (now.getTime() - evaluatedAt > LISTING_COMPLETENESS_REFRESH_MS) {
      aged.push({ id: sale.id, evaluatedAt });
    }
  }

  const byEvaluationDate = (
    left: { id: string; evaluatedAt: number },
    right: { id: string; evaluatedAt: number },
  ) => left.evaluatedAt - right.evaluatedAt || left.id.localeCompare(right.id);

  return [
    ...missing
      .sort(
        (left, right) =>
          (time(right.updatedAt) ?? 0) - (time(left.updatedAt) ?? 0) ||
          left.id.localeCompare(right.id),
      )
      .map((sale) => sale.id),
    ...outdatedPolicy.sort(byEvaluationDate).map((sale) => sale.id),
    ...modified.sort(byEvaluationDate).map((sale) => sale.id),
    ...aged.sort(byEvaluationDate).map((sale) => sale.id),
  ];
}

/**
 * Évaluation d'une annonce : score de la fiche (stocké pour la mesure), palier tiré de ce score
 * arrondi au dixième (celui qui est stocké: un 39,96 stocké 40,0 est au palier haut), et empreinte
 * des données lues.
 */
export function evaluateListing(sale: AuctionSale, evaluatedAt: Date) {
  const readable = sanitizeAuctionSaleForDisplay(sale);
  const { score: rawScore } = getListingCompleteness(readable);
  // La colonne est numeric(4,1) avec un contrôle 0-100 : un score invalide ferait échouer tout
  // l'upsert du paquet. Il est refusé ici (la vente est sautée et comptée en erreur).
  if (
    typeof rawScore !== "number" ||
    !Number.isFinite(rawScore) ||
    rawScore < 0 ||
    rawScore > 100
  ) {
    throw new Error(`Score de complétude invalide pour ${sale.id} : ${String(rawScore)}`);
  }
  const score = Math.round(rawScore * 10) / 10;
  return {
    sale_id: sale.id,
    score,
    tier: completenessTierForScore(score),
    policy_version: LISTING_COMPLETENESS_POLICY.version,
    // Empreinte des données lues: sert à la mesure et au diagnostic (savoir si une réévaluation a
    // vu des données différentes). Elle ne pilote pas la sélection: `evaluated_at` doit avancer à
    // chaque passage pour que la réévaluation quotidienne ne reprenne pas toujours les mêmes ventes.
    input_fingerprint: createHash("sha256").update(JSON.stringify(readable)).digest("hex"),
    evaluated_at: evaluatedAt.toISOString(),
  };
}

async function readOnlineSales(): Promise<OnlineSale[]> {
  const sales: OnlineSale[] = [];
  for (let from = 0; from < MAX_ONLINE_SALES; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("v_auction_sales_app")
      .select("id, updated_at")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      if (row.id) sales.push({ id: row.id, updatedAt: row.updated_at });
    }
    if ((data?.length ?? 0) < PAGE_SIZE) return sales;
  }
  throw new Error("Trop de ventes en ligne pour l'évaluation de complétude.");
}

async function readStoredEvaluations(): Promise<StoredEvaluation[]> {
  const rows: StoredEvaluation[] = [];
  for (let from = 0; from < MAX_ONLINE_SALES; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("auction_sale_listing_completeness")
      .select("sale_id, evaluated_at, policy_version")
      .order("sale_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      rows.push({
        saleId: row.sale_id,
        evaluatedAt: row.evaluated_at,
        policyVersion: row.policy_version,
      });
    }
    if ((data?.length ?? 0) < PAGE_SIZE) return rows;
  }
  throw new Error("Trop d'évaluations de complétude stockées.");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export async function runListingCompletenessBatch({
  limit = 300,
  now = new Date(),
  timeBudgetMs = 240_000,
}: {
  limit?: number;
  now?: Date;
  /** Temps au-delà duquel on ne lit plus de nouveau lot (la prochaine exécution reprend). */
  timeBudgetMs?: number;
} = {}): Promise<ListingCompletenessBatchResult> {
  const startedAt = Date.now();
  const batchLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
  const [online, evaluations] = await Promise.all([readOnlineSales(), readStoredEvaluations()]);
  const pending = pickPendingSales(online, evaluations, LISTING_COMPLETENESS_POLICY.version, now);
  const selected = pending.slice(0, batchLimit);
  const result: ListingCompletenessBatchResult = {
    policyVersion: LISTING_COMPLETENESS_POLICY.version,
    online: online.length,
    pending: pending.length,
    evaluated: 0,
    highTier: 0,
    failed: 0,
    remaining: pending.length,
    errors: [],
  };
  const fail = (count: number, error: unknown) => {
    result.failed += count;
    if (result.errors.length < MAX_REPORTED_ERRORS) result.errors.push(errorMessage(error));
  };

  for (let index = 0; index < selected.length; index += READ_CHUNK_SIZE) {
    if (Date.now() - startedAt > timeBudgetMs) break;
    const ids = selected.slice(index, index + READ_CHUNK_SIZE);
    const { data, error } = await supabaseAdmin
      .from("v_auction_sales_app")
      .select("*")
      .in("id", ids);
    if (error) {
      fail(ids.length, error);
      continue;
    }

    const rows: ReturnType<typeof evaluateListing>[] = [];
    for (const sale of (data ?? []) as unknown as AuctionSale[]) {
      try {
        rows.push(evaluateListing(sale, now));
      } catch (evaluationError) {
        fail(1, evaluationError);
      }
    }
    if (!rows.length) continue;

    const { error: upsertError } = await supabaseAdmin
      .from("auction_sale_listing_completeness")
      .upsert(rows, { onConflict: "sale_id" });
    if (upsertError) {
      fail(rows.length, upsertError);
      continue;
    }
    result.evaluated += rows.length;
    result.highTier += rows.filter((row) => row.tier === COMPLETENESS_TIER_HIGH).length;
  }

  result.remaining = Math.max(0, pending.length - result.evaluated);
  // Aucune évaluation alors qu'il y en avait à faire : la tâche est en panne, on la signale.
  if (result.evaluated === 0 && result.failed > 0) {
    throw new Error(`Évaluation de complétude impossible : ${result.errors.join(" ; ")}`);
  }
  // Un échec partiel n'est pas un succès quand il cesse d'être isolé : 20 % ou plus des évaluations
  // tentées en échec. Les lignes évaluées sont enregistrées ; la passe suivante (toutes les heures)
  // reprend le reste.
  const attempted = result.evaluated + result.failed;
  if (result.failed > 0 && result.failed / attempted >= COMPLETENESS_FAILURE_RATE_THRESHOLD) {
    throw new Error(
      `Évaluation de complétude partielle : ${result.failed} échec(s) sur ${attempted} évaluation(s) tentée(s) (seuil ${COMPLETENESS_FAILURE_RATE_THRESHOLD * 100} %) : ${result.errors.join(" ; ")}`,
    );
  }
  return result;
}
