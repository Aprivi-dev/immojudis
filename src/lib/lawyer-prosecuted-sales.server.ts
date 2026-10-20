import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PublicApiError } from "@/lib/api-errors";
import {
  MAX_PROSECUTED_SALES_PER_LAWYER,
  matchProsecutedSales,
  type LawyerDirectorySale,
  type LawyerProsecutedSalesResponse,
  type LawyerUpcomingSales,
  type ProsecutionLawyer,
  type ProsecutionSaleCandidate,
} from "@/lib/lawyer-prosecuted-sales";
import { readPagedRows } from "@/lib/paged-read";
import { LAWYER_DIRECTORY_PAGE_SIZE } from "@/lib/rate-limit-policies";
import {
  isPublicationQuarantinedGuardRow,
  PUBLICATION_QUARANTINE_SELECT,
} from "@/lib/sale-publication-guard";

/**
 * Ventes à venir d'un avocat de l'annuaire où il est l'avocat poursuivant (point 72b). Le
 * rapprochement, volontairement strict, est décrit dans `lawyer-prosecuted-sales.ts`.
 *
 * Le nom de l'avocat poursuivant n'est PAS un champ de la fiche publique d'une vente (il n'est
 * visible qu'avec un compte) : il ne sert ici qu'à rapprocher. Ce qui est affiché vient de
 * `get_public_sale_summary`, la lecture des faits publics d'une vente, qui ne rend rien pour une
 * vente absente du catalogue public (retirée, expirée, en quarantaine).
 */

const CANDIDATE_PAGE_SIZE = 1_000;
const CANDIDATE_MAX_ROWS = 5_000;
/** Les ventes à venir changent peu : une lecture sert les requêtes de l'annuaire pendant 5 minutes. */
const CANDIDATE_CACHE_MS = 5 * 60_000;
/** Plafonds des lectures publiques d'une vente : par avocat, puis par requête de l'annuaire. */
const MAX_PUBLIC_READS_PER_LAWYER = 10;
const MAX_PUBLIC_READS_PER_REQUEST = 60;

let candidateCache: { loadedAt: number; sales: ProsecutionSaleCandidate[] } | null = null;

/** Vide la mémoire des ventes à venir (tests). */
export function clearUpcomingProsecutionCache() {
  candidateCache = null;
}

type CandidateRow = {
  id: string;
  lawyer_name: string | null;
  tribunal: string | null;
  sale_date: string | null;
  status?: unknown;
  catalogue_quarantined?: unknown;
  publication_quarantine?: unknown;
  publication_identity_conflict?: unknown;
  source_identity_mismatch?: unknown;
};

async function loadUpcomingCandidates(now: Date): Promise<ProsecutionSaleCandidate[]> {
  if (candidateCache && now.getTime() - candidateCache.loadedAt < CANDIDATE_CACHE_MS) {
    return candidateCache.sales;
  }

  const { rows } = await readPagedRows<CandidateRow>({
    pageSize: CANDIDATE_PAGE_SIZE,
    maxRows: CANDIDATE_MAX_ROWS,
    readPage: async (offset) => {
      const { data, error } = await supabaseAdmin
        .from("auction_sales")
        .select(`id,lawyer_name,tribunal,sale_date,${PUBLICATION_QUARANTINE_SELECT}` as const)
        .eq("status", "upcoming")
        .gte("sale_date", now.toISOString())
        .not("lawyer_name", "is", null)
        .order("sale_date", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + CANDIDATE_PAGE_SIZE - 1);
      if (error) throw error;
      return (data ?? []) as unknown as CandidateRow[];
    },
  });

  const sales = rows
    .filter((row) => !isPublicationQuarantinedGuardRow(row))
    .map((row) => ({
      id: row.id,
      lawyerName: row.lawyer_name,
      tribunal: row.tribunal,
      saleDate: row.sale_date,
    }));
  candidateCache = { loadedAt: now.getTime(), sales };
  return sales;
}

type PublicSummaryRow = {
  id: string;
  city: string | null;
  property_type: string | null;
  sale_date: string | null;
  starting_price_eur: number | null;
  sale_venue_type: string | null;
  tribunal_name: string | null;
};

/** Faits publics d'une vente, ou `null` si elle n'est pas (ou plus) dans le catalogue public. */
async function readPublicSale(saleId: string, now: Date): Promise<LawyerDirectorySale | null> {
  const { data, error } = await supabaseAdmin.rpc("get_public_sale_summary", {
    p_sale_id: saleId,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as PublicSummaryRow | null | undefined;
  if (!row || row.sale_venue_type !== "tribunal") return null;
  if (row.sale_date && new Date(row.sale_date).getTime() < now.getTime()) return null;
  return {
    id: row.id,
    city: row.city,
    propertyType: row.property_type,
    saleDate: row.sale_date,
    startingPriceEur: row.starting_price_eur,
    tribunalName: row.tribunal_name,
  };
}

/**
 * Ventes à venir des avocats de `forLawyerIds`, par identifiant d'avocat. `lawyers` est la liste
 * COMPLÈTE des avocats référencés, pas seulement ceux qui sont affichés : le rapprochement écarte
 * les homonymes du même barreau, il doit donc tous les connaître. Un avocat sans vente rapprochée
 * n'a pas d'entrée. Une erreur de lecture se propage : l'appelant décide de continuer sans cette
 * information.
 */
export async function loadUpcomingProsecutedSales(
  lawyers: readonly ProsecutionLawyer[],
  forLawyerIds: ReadonlySet<string>,
  now = new Date(),
): Promise<Map<string, LawyerUpcomingSales>> {
  const result = new Map<string, LawyerUpcomingSales>();
  if (!forLawyerIds.size) return result;

  const allMatches = matchProsecutedSales(lawyers, await loadUpcomingCandidates(now));
  const matches = new Map([...allMatches].filter(([lawyerId]) => forLawyerIds.has(lawyerId)));
  if (!matches.size) return result;

  // Lectures publiques bornées : par avocat, puis pour toute la requête.
  let budget = MAX_PUBLIC_READS_PER_REQUEST;
  const reads: Array<{ lawyerId: string; saleIds: string[] }> = [];
  for (const [lawyerId, saleIds] of matches) {
    const saleIdsToRead = saleIds.slice(0, Math.min(MAX_PUBLIC_READS_PER_LAWYER, budget));
    budget -= saleIdsToRead.length;
    if (saleIdsToRead.length) reads.push({ lawyerId, saleIds: saleIdsToRead });
  }

  await Promise.all(
    reads.map(async ({ lawyerId, saleIds }) => {
      const sales = (
        await Promise.all(saleIds.map((saleId) => readPublicSale(saleId, now)))
      ).filter((sale): sale is LawyerDirectorySale => sale !== null);
      if (sales.length) {
        result.set(lawyerId, {
          sales: sales.slice(0, MAX_PROSECUTED_SALES_PER_LAWYER),
          total: sales.length,
        });
      }
    }),
  );
  return result;
}

const lawyerIdSchema = z.string().uuid();

/**
 * Identifiants d'avocats demandés (`lawyerIds=a,b,c`, ceux d'une page de l'annuaire : au plus
 * `LAWYER_DIRECTORY_PAGE_SIZE`). Une liste vide, trop longue ou mal formée est refusée (400).
 */
export function parseLawyerIdsParam(raw: string | null): string[] {
  const ids = [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  if (
    ids.length === 0 ||
    ids.length > LAWYER_DIRECTORY_PAGE_SIZE ||
    !ids.every((id) => lawyerIdSchema.safeParse(id).success)
  ) {
    throw new PublicApiError("Requête invalide : liste d'avocats incorrecte.", 400);
  }
  return ids;
}

/**
 * Ventes à venir des avocats demandés, rendues à un compte payant par la route authentifiée
 * `/api/lawyers/prosecuted-sales`. Le rapprochement connaît TOUS les avocats référencés actifs
 * (même lecture que l'annuaire) pour écarter les homonymes d'un même barreau.
 */
export async function loadProsecutedSalesForLawyerIds(
  lawyerIds: readonly string[],
  now = new Date(),
): Promise<LawyerProsecutedSalesResponse> {
  const { data, error } = await supabaseAdmin
    .from("referenced_lawyers")
    .select("id,display_name,bar_association")
    .eq("status", "active")
    .eq("accepts_judicial_auctions", true);
  if (error) throw error;

  const lawyers = (data ?? []).map(
    (lawyer): ProsecutionLawyer => ({
      id: lawyer.id,
      displayName: lawyer.display_name,
      barAssociation: lawyer.bar_association,
    }),
  );
  const upcoming = await loadUpcomingProsecutedSales(lawyers, new Set(lawyerIds), now);
  return { lawyers: Object.fromEntries(upcoming) };
}
