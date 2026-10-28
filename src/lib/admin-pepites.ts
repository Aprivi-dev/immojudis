import "server-only";
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { adminDeadlineSignal } from "@/lib/admin-route-deadline";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asRecord, asRecordOrNull } from "@/lib/guards";
import { matchProsecutedSales, type ProsecutionLawyer } from "@/lib/lawyer-prosecuted-sales";
import { PUBLIC_CATALOGUE_CACHE_TAG } from "@/lib/public-catalogue.server";
import { PUBLIC_SALES_CACHE_TAG } from "@/lib/public-sale.server";
import { describePepiteReasonCodes } from "@/lib/pepite-reasons";
import { activePepiteRuleVersion } from "@/lib/pepite-rule-switch.server";
import {
  PEPITE_RATE_ALERT_MAX,
  PEPITE_RATE_ALERT_MIN,
  PEPITE_TARGET_RATE_MAX,
  PEPITE_TARGET_RATE_MIN,
} from "@/lib/pepite-policy";

/**
 * Page d'administration des pépites (`/admin/pepites`) : le mode, les compteurs par type de vente, le taux de
 * pépites parmi les ventes évaluables, la liste des pépites et des « presque pépites » avec leurs critères en
 * clair, et le contrôle d'indépendance vis-à-vis de la publicité.
 *
 * Lecture seule. Jeton de session vérifié et rôle administrateur exigé avant toute lecture ; les lectures se
 * font avec le client de service (`admin_list_sale_pepites`, service_role seul). Avant la migration
 * 20261104100000 (fonction ou table absente), la réponse dit « pas migré » au lieu d'échouer.
 *
 * Le contrôle d'indépendance (proposition n° 21) lit les encarts d'avocats pour mesurer la part des pépites
 * dont l'avocat poursuivant est sponsorisé : il vit ici, côté administration, et n'entre JAMAIS dans la règle
 * (`pepite-policy.ts`, `pepite-input.ts`, `sale-pepites-batch.ts` n'importent aucun module d'avocats).
 */

export type PepiteVenue = "tribunal" | "notary" | "other";

export const PEPITE_VENUE_LABELS: Record<PepiteVenue, string> = {
  tribunal: "Tribunal",
  notary: "Vente notariale",
  other: "Autre ou inconnu",
};

export type AdminPepiteCounters = {
  venue: PepiteVenue;
  label: string;
  evaluated: number;
  pepites: number;
  /** Une évaluation favorable de plus à attendre avant la publication. */
  pending: number;
  notPepite: number;
  notApplicable: number;
  insufficient: number;
  /** Pépites, à confirmer et pas pépites : les ventes dont tous les tests ont pu être faits. */
  evaluable: number;
  /** Pas pépites arrêtées par le seul garde-fou d'écart aberrant (mise à prix sous 10 % ou au-dessus de 150 % de la valeur). */
  onlyGapGuard: number;
};

export type AdminPepiteRow = {
  saleId: string;
  /** « pepite » : publiée ; « pending » : à confirmer ; « near » : un seul critère manqué. */
  category: "pepite" | "pending" | "near";
  title: string | null;
  city: string | null;
  tribunal: string | null;
  venue: PepiteVenue;
  venueLabel: string;
  saleDate: string | null;
  startingPriceEur: number | null;
  referenceCeilingEur: number | null;
  probablePriceEur: number | null;
  rangeLowEur: number | null;
  rangeHighEur: number | null;
  /** Part B (0 à 1) ; `null` hors tribunal. */
  chanceShare: number | null;
  chanceAtLeast: boolean;
  /** Ratio C (coût total au prix probable / valeur centrale). */
  costRatio: number | null;
  passed: string[];
  missed: string[];
  stability: string[];
  evaluatedAt: string;
  frozenAt: string | null;
  href: string;
};

export type PepiteIndependence = {
  /** Ventes évaluables dont l'avocat poursuivant a pu être rapproché d'un avocat référencé. */
  evaluatedSales: number;
  evaluatedSponsored: number;
  evaluatedShare: number | null;
  pepiteSales: number;
  pepiteSponsored: number;
  pepiteShare: number | null;
  /** Écart de la part des pépites sur celle de l'ensemble, en points. */
  gapPoints: number | null;
  /** La part des pépites dépasse celle de l'ensemble d'au moins `alertPoints`, sur au moins `minPepites` pépites. */
  alert: boolean;
  alertPoints: number;
  minPepites: number;
};

/** Écart de part (en points) à partir duquel le contrôle d'indépendance alerte, sur un échantillon suffisant. */
export const INDEPENDENCE_ALERT_POINTS = 10;
export const INDEPENDENCE_MIN_PEPITES = 10;

export type AdminPepitesResponse = {
  /** Faux avant la migration : rien n'est lu. */
  migrated: boolean;
  generatedAt: string | null;
  mode: "off" | "shadow" | "on" | "unknown";
  ruleVersion: string;
  counters: AdminPepiteCounters[];
  totals: Omit<AdminPepiteCounters, "venue" | "label">;
  rate: {
    /** Pépites (publiées et à confirmer) parmi les ventes évaluables ; `null` sans vente évaluable. */
    share: number | null;
    pepites: number;
    evaluable: number;
    /** « below » sous la plage d'alerte, « above » au-dessus. */
    alert: "below" | "above" | null;
    alertMin: number;
    alertMax: number;
    targetMin: number;
    targetMax: number;
  };
  rows: AdminPepiteRow[];
  /** `null` : le contrôle n'a pas pu être fait (lecture impossible). */
  independence: PepiteIndependence | null;
  /**
   * Ventes à venir en attente de réobservation d'inondation (une tentative a échoué : `failure_count > 0`), donc
   * « inconnu par panne » et non par position imprécise. La règle v2 est prête côté inondation quand il est nul.
   * `null` : non mesuré (fonction absente avant la migration 20261108100100, ou lecture impossible).
   */
  floodReobservationPending: number | null;
};

const VENUES: readonly PepiteVenue[] = ["tribunal", "notary", "other"];

function integer(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function venueOf(value: unknown): PepiteVenue {
  return VENUES.includes(value as PepiteVenue) ? (value as PepiteVenue) : "other";
}

function parseCounters(raw: unknown): AdminPepiteCounters[] {
  const entries = Array.isArray(raw) ? raw.map(asRecordOrNull) : [];
  return VENUES.map((venue) => {
    const entry = entries.find((item) => item?.venue === venue) ?? {};
    return {
      venue,
      label: PEPITE_VENUE_LABELS[venue],
      evaluated: integer(entry.evaluated),
      pepites: integer(entry.pepites),
      pending: integer(entry.pending),
      notPepite: integer(entry.not_pepite),
      notApplicable: integer(entry.not_applicable),
      insufficient: integer(entry.insufficient),
      evaluable: integer(entry.evaluable),
      onlyGapGuard: integer(entry.only_gap_guard),
    };
  });
}

function sumCounters(counters: readonly AdminPepiteCounters[]): AdminPepitesResponse["totals"] {
  const total = {
    evaluated: 0,
    pepites: 0,
    pending: 0,
    notPepite: 0,
    notApplicable: 0,
    insufficient: 0,
    evaluable: 0,
    onlyGapGuard: 0,
  };
  for (const counter of counters) {
    total.evaluated += counter.evaluated;
    total.pepites += counter.pepites;
    total.pending += counter.pending;
    total.notPepite += counter.notPepite;
    total.notApplicable += counter.notApplicable;
    total.insufficient += counter.insufficient;
    total.evaluable += counter.evaluable;
    total.onlyGapGuard += counter.onlyGapGuard;
  }
  return total;
}

/** Taux de pépites (publiées et à confirmer) parmi les ventes évaluables, et alerte hors de la plage 2 % à 15 %. */
export function pepiteRate(
  pepites: number,
  pending: number,
  evaluable: number,
): AdminPepitesResponse["rate"] {
  const count = pepites + pending;
  const share = evaluable > 0 ? count / evaluable : null;
  return {
    share,
    pepites: count,
    evaluable,
    alert:
      share == null
        ? null
        : share < PEPITE_RATE_ALERT_MIN
          ? "below"
          : share > PEPITE_RATE_ALERT_MAX
            ? "above"
            : null,
    alertMin: PEPITE_RATE_ALERT_MIN,
    alertMax: PEPITE_RATE_ALERT_MAX,
    targetMin: PEPITE_TARGET_RATE_MIN,
    targetMax: PEPITE_TARGET_RATE_MAX,
  };
}

export function parseAdminPepiteRow(raw: unknown): AdminPepiteRow | null {
  const row = asRecordOrNull(raw);
  const saleId = textOrNull(row?.sale_id);
  if (!row || !saleId) return null;
  const details = asRecord(row.details);
  const codes = Array.isArray(row.reason_codes)
    ? row.reason_codes.filter((code): code is string => typeof code === "string")
    : [];
  const flood = asRecordOrNull(details.flood);
  const reasons = describePepiteReasonCodes(codes, flood);
  const venue = venueOf(row.venue);
  const isPepite = row.is_pepite === true;
  return {
    saleId,
    category: isPepite ? "pepite" : row.status === "pepite" ? "pending" : "near",
    title: textOrNull(row.title),
    city: textOrNull(row.city),
    tribunal: textOrNull(row.tribunal),
    venue,
    venueLabel: PEPITE_VENUE_LABELS[venue],
    saleDate: textOrNull(row.sale_date),
    startingPriceEur: numberOrNull(row.starting_price_eur),
    referenceCeilingEur: numberOrNull(details.referenceCeilingEur),
    probablePriceEur: numberOrNull(details.probablePriceEur),
    rangeLowEur: numberOrNull(details.rangeLowEur),
    rangeHighEur: numberOrNull(details.rangeHighEur),
    chanceShare: numberOrNull(details.chanceShare),
    chanceAtLeast: details.chanceAtLeast === true,
    costRatio: numberOrNull(details.costRatio),
    passed: reasons.passed,
    missed: reasons.missed,
    stability: reasons.stability,
    evaluatedAt: textOrNull(row.evaluated_at) ?? "",
    frozenAt: textOrNull(row.frozen_at),
    href: `/sales/${encodeURIComponent(saleId)}`,
  };
}

/** Table ou fonction inconnue de la base : la migration n'est pas encore appliquée. */
function isMissingDatabaseObject(error: { code?: string } | null): boolean {
  return (
    error?.code === "PGRST202" ||
    error?.code === "PGRST205" ||
    error?.code === "42883" ||
    error?.code === "42P01"
  );
}

export function unavailablePepites(): AdminPepitesResponse {
  const counters = parseCounters(null);
  const totals = sumCounters(counters);
  return {
    migrated: false,
    generatedAt: null,
    mode: "unknown",
    ruleVersion: activePepiteRuleVersion(),
    counters,
    totals,
    rate: pepiteRate(0, 0, 0),
    rows: [],
    independence: null,
    floodReobservationPending: null,
  };
}

/** Le compteur ne fait jamais tomber la page : fonction absente, erreur ou réponse inattendue valent « non mesuré ». */
async function readFloodReobservationPending(now: Date): Promise<number | null> {
  try {
    const { data, error } = await supabaseAdmin.rpc("admin_count_flood_reobservation_pending", {
      p_now: now.toISOString(),
    });
    if (error) return null;
    return typeof data === "number" && Number.isFinite(data) ? data : null;
  } catch {
    return null;
  }
}

const PAGE_SIZE = 1000;
const IN_CHUNK = 200;
const MAX_ROWS = 20_000;

type EvaluatedRef = { saleId: string; isPepite: boolean; pending: boolean };

/** Les ventes évaluables (pépites, à confirmer, pas pépites) : l'ensemble sur lequel on compare. */
async function readEvaluable(): Promise<EvaluatedRef[]> {
  const refs: EvaluatedRef[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("auction_sale_pepites")
      .select("sale_id, status, is_pepite")
      .in("status", ["pepite", "not_pepite"])
      .order("sale_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      refs.push({
        saleId: row.sale_id,
        isPepite: row.is_pepite,
        pending: row.status === "pepite" && !row.is_pepite,
      });
    }
    if ((data?.length ?? 0) < PAGE_SIZE) return refs;
  }
  throw new Error("Trop d'évaluations de pépites.");
}

/**
 * Contrôle d'indépendance : la part des pépites dont l'avocat poursuivant est un avocat référencé
 * actuellement sponsorisé (offre d'essai ou active, dans sa période), comparée à la même part dans
 * l'ensemble des ventes évaluables. Le rapprochement est celui de la fiche d'avocat
 * (`matchProsecutedSales`, volontairement strict : un faux rapprochement est écarté). Une part des
 * pépites nettement au-dessus de celle de l'ensemble est le signal d'une dérive à examiner.
 */
export async function computePepiteIndependence(
  now: Date,
  signal?: AbortSignal,
): Promise<PepiteIndependence> {
  // Entre deux lectures, on s'arrête dès que le délai est dépassé (la page affichera « non mesuré »).
  const checkpoint = () => {
    if (signal?.aborted) throw new Error("Contrôle d'indépendance interrompu : délai dépassé.");
  };
  const evaluable = await readEvaluable();
  checkpoint();
  if (evaluable.length === 0) {
    return {
      evaluatedSales: 0,
      evaluatedSponsored: 0,
      evaluatedShare: null,
      pepiteSales: 0,
      pepiteSponsored: 0,
      pepiteShare: null,
      gapPoints: null,
      alert: false,
      alertPoints: INDEPENDENCE_ALERT_POINTS,
      minPepites: INDEPENDENCE_MIN_PEPITES,
    };
  }

  const candidates: Array<{
    id: string;
    lawyerName: string | null;
    tribunal: string | null;
    saleDate: string | null;
  }> = [];
  for (let index = 0; index < evaluable.length; index += IN_CHUNK) {
    checkpoint();
    const ids = evaluable.slice(index, index + IN_CHUNK).map((ref) => ref.saleId);
    const { data, error } = await supabaseAdmin
      .from("auction_sales")
      .select("id, lawyer_name, tribunal, sale_date")
      .in("id", ids);
    if (error) throw error;
    for (const row of data ?? []) {
      candidates.push({
        id: row.id,
        lawyerName: row.lawyer_name,
        tribunal: row.tribunal,
        saleDate: row.sale_date,
      });
    }
  }

  checkpoint();
  const { data: lawyerRows, error: lawyerError } = await supabaseAdmin
    .from("referenced_lawyers")
    .select(
      "id, display_name, bar_association, paid_placement_status, paid_placement_starts_at, paid_placement_ends_at",
    )
    .eq("status", "active")
    .eq("accepts_judicial_auctions", true);
  if (lawyerError) throw lawyerError;
  const lawyers: ProsecutionLawyer[] = (lawyerRows ?? []).map((lawyer) => ({
    id: lawyer.id,
    displayName: lawyer.display_name,
    barAssociation: lawyer.bar_association,
  }));
  const nowMs = now.getTime();
  const sponsoredIds = new Set(
    (lawyerRows ?? [])
      .filter((lawyer) => {
        if (lawyer.paid_placement_status !== "trial" && lawyer.paid_placement_status !== "active")
          return false;
        const startsAt = lawyer.paid_placement_starts_at
          ? Date.parse(lawyer.paid_placement_starts_at)
          : null;
        const endsAt = lawyer.paid_placement_ends_at
          ? Date.parse(lawyer.paid_placement_ends_at)
          : null;
        return (startsAt == null || startsAt <= nowMs) && (endsAt == null || endsAt >= nowMs);
      })
      .map((lawyer) => lawyer.id),
  );

  // Ventes dont l'avocat poursuivant est rapproché d'un avocat référencé, et celles dont il est sponsorisé.
  const matched = matchProsecutedSales(lawyers, candidates);
  const matchedSales = new Set<string>();
  const sponsoredSales = new Set<string>();
  for (const [lawyerId, saleIds] of matched) {
    for (const saleId of saleIds) {
      matchedSales.add(saleId);
      if (sponsoredIds.has(lawyerId)) sponsoredSales.add(saleId);
    }
  }

  const pepites = evaluable.filter((ref) => ref.isPepite || ref.pending);
  const share = (count: number, total: number) => (total > 0 ? count / total : null);
  const evaluatedSponsored = evaluable.filter((ref) => sponsoredSales.has(ref.saleId)).length;
  const pepiteSponsored = pepites.filter((ref) => sponsoredSales.has(ref.saleId)).length;
  const evaluatedShare = share(evaluatedSponsored, evaluable.length);
  const pepiteShare = share(pepiteSponsored, pepites.length);
  const gapPoints =
    evaluatedShare != null && pepiteShare != null ? (pepiteShare - evaluatedShare) * 100 : null;
  return {
    evaluatedSales: evaluable.length,
    evaluatedSponsored,
    evaluatedShare,
    pepiteSales: pepites.length,
    pepiteSponsored,
    pepiteShare,
    gapPoints,
    alert:
      gapPoints != null &&
      pepites.length >= INDEPENDENCE_MIN_PEPITES &&
      gapPoints >= INDEPENDENCE_ALERT_POINTS,
    alertPoints: INDEPENDENCE_ALERT_POINTS,
    minPepites: INDEPENDENCE_MIN_PEPITES,
  };
}

/** Temps laissé au contrôle d'indépendance : au-delà, la page l'affiche « non mesuré ». */
export const INDEPENDENCE_BUDGET_MS = 15_000;

/** Jeton et rôle administrateur vérifiés, puis lecture avec le client de service. */
export async function getAdminPepites(
  authToken: string,
  now = new Date(),
  { independenceBudgetMs = INDEPENDENCE_BUDGET_MS }: { independenceBudgetMs?: number } = {},
): Promise<AdminPepitesResponse> {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");

  // Le contrôle d'indépendance part en même temps que la liste, avec son propre budget de temps et celui de
  // la route : il ne doit jamais faire échouer, ni ralentir au-delà du délai, le reste de la page.
  const budget = AbortSignal.any(
    [AbortSignal.timeout(independenceBudgetMs), adminDeadlineSignal()].filter(
      (item): item is AbortSignal => item != null,
    ),
  );
  const independenceRead = computePepiteIndependence(now, budget).catch(() => {
    console.error("[admin-pepites] contrôle d'indépendance indisponible");
    return null;
  });
  const overrun = new Promise<null>((resolve) => {
    if (budget.aborted) resolve(null);
    else budget.addEventListener("abort", () => resolve(null), { once: true });
  });

  const { data, error } = await supabaseAdmin.rpc("admin_list_sale_pepites", {
    p_now: now.toISOString(),
    p_limit: 300,
  });
  if (error) {
    if (isMissingDatabaseObject(error)) return unavailablePepites();
    throw error;
  }

  const body = asRecord(data);
  const counters = parseCounters(body.counters);
  const totals = sumCounters(counters);
  const mode =
    body.mode === "off" || body.mode === "shadow" || body.mode === "on" ? body.mode : "unknown";
  const rows = (Array.isArray(body.rows) ? body.rows : [])
    .map(parseAdminPepiteRow)
    .filter((row): row is AdminPepiteRow => row !== null);

  const floodReobservationPending = await readFloodReobservationPending(now);
  const independence = await Promise.race([independenceRead, overrun]);

  return {
    migrated: true,
    generatedAt: textOrNull(body.generated_at),
    mode,
    ruleVersion: activePepiteRuleVersion(),
    counters,
    totals,
    rate: pepiteRate(totals.pepites, totals.pending, totals.evaluable),
    rows,
    independence,
    floodReobservationPending,
  };
}

/**
 * Arrêt d'urgence : « Suspendre les pépites » repasse le mode de « on » à « shadow » (ou « off »), jamais
 * l'inverse (`suspend_sale_pepites`, migration 20261104100000). L'ouverture se fait par une migration dédiée.
 * Jeton et rôle administrateur vérifiés avant l'appel ; l'administrateur est consigné dans la base.
 */
export const adminPepitesSuspendSchema = z
  .object({ mode: z.enum(["shadow", "off"]).default("shadow") })
  .strict();
export type AdminPepitesSuspendInput = z.input<typeof adminPepitesSuspendSchema>;

/**
 * Après un arrêt d'urgence réussi : les caches du site qui portent le repère sont expirés tout de suite, au lieu
 * d'attendre leur durée (5 minutes) : la liste publique et les lectures de recherche (`public-catalogue`), les
 * lectures de chaque fiche publique (`public-sales`) et les pages des fiches. Même API que
 * `/api/pipeline/revalidate-sale`. Les copies du CDN ne se purgent pas par étiquette : les routes des pépites les
 * gardent une minute seulement. Un échec d'expiration (hors requête) ne défait pas l'arrêt, déjà enregistré.
 */
function expirePepiteCaches(): void {
  try {
    revalidateTag(PUBLIC_CATALOGUE_CACHE_TAG, { expire: 0 });
    revalidateTag(PUBLIC_SALES_CACHE_TAG, { expire: 0 });
    revalidatePath("/sales/[id]", "page");
  } catch (error) {
    console.warn(
      JSON.stringify({
        scope: "admin.pepites",
        event: "cache_expiry_failed",
        code: (error as { code?: unknown } | null)?.code ?? null,
      }),
    );
  }
}

export async function suspendAdminPepites(
  authToken: string,
  input: AdminPepitesSuspendInput = {},
): Promise<{ mode: AdminPepitesResponse["mode"] }> {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
  const { mode } = adminPepitesSuspendSchema.parse(input);

  const { data, error } = await supabaseAdmin.rpc("suspend_sale_pepites", {
    p_mode: mode,
    p_user_id: auth.userId,
  });
  if (error) throw error;
  console.info(JSON.stringify({ scope: "admin.pepites", userId: auth.userId, mode: data }));
  expirePepiteCaches();
  return { mode: data === "off" || data === "shadow" || data === "on" ? data : "unknown" };
}
