import "server-only";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { isLaunchOfferActive } from "@/lib/launch-offer.server";
import { featureIncluded, isPlanPeriodActive } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { DETAIL_VIEW, SALE_LIST_COLUMNS } from "@/lib/sale-views";
import { saleRows } from "@/lib/sale-rows";
import {
  getPublicationVisibleSaleIds,
  isPublicationQuarantinedGuardRow,
  PUBLICATION_QUARANTINE_SELECT,
  SalePublicationUnavailableError,
} from "@/lib/sale-publication-guard";
import {
  GRAVE_SALE_STATUSES,
  SALE_CHANGE_REASON_SOURCE_ABSENCE,
  SOURCE_ABSENCE_LABEL,
} from "@/lib/sale-change-display";
import { systemAuthForUser } from "@/lib/system-auth";
import type { AuctionSale } from "@/lib/types";
import { recordFeatureUsageEvent } from "@/lib/usage";
import { asRecord, numberValue, stringValue } from "@/lib/guards";

export const SALE_WATCH_KINDS = ["alert_match", "favorite", "workspace"] as const;
export const SALE_CHANGE_EVENT_KINDS = [
  "price_changed",
  "audience_changed",
  "status_changed",
  "documents_changed",
  "score_changed",
] as const;
export const SALE_CHANGE_SEVERITIES = ["info", "important", "urgent"] as const;

export type SaleWatchKind = (typeof SALE_WATCH_KINDS)[number];
export type SaleChangeEventKind = (typeof SALE_CHANGE_EVENT_KINDS)[number];
export type SaleChangeSeverity = (typeof SALE_CHANGE_SEVERITIES)[number];

type SaleWatchSnapshotRow = Database["public"]["Tables"]["user_sale_watch_snapshots"]["Row"];
type SaleWatchSnapshotInsert = Database["public"]["Tables"]["user_sale_watch_snapshots"]["Insert"];
type SaleChangeEventRow = Database["public"]["Tables"]["user_sale_change_events"]["Row"];
type SaleChangeEventInsert = Database["public"]["Tables"]["user_sale_change_events"]["Insert"];
type SaleChangeEventUpdate = Database["public"]["Tables"]["user_sale_change_events"]["Update"];

type AlertMatchWatchRow = Pick<
  Database["public"]["Tables"]["user_alert_matches"]["Row"],
  "id" | "sale_id" | "match_snapshot" | "matched_at"
>;
type FavoriteWatchRow = Pick<
  Database["public"]["Tables"]["user_favorites"]["Row"],
  "id" | "sale_id" | "created_at"
>;
type WorkspaceWatchRow = Pick<
  Database["public"]["Tables"]["sale_workspaces"]["Row"],
  "id" | "sale_id" | "updated_at"
>;

export type SaleChangeSnapshot = {
  title: string | null;
  city: string | null;
  department: string | null;
  startingPriceEur: number | null;
  saleDate: string | null;
  status: string | null;
  investmentScore: number | null;
  documentCount: number | null;
  documentSignature: string | null;
  updatedAt: string | null;
  sourceUrl: string | null;
};

export type SaleWatchSource = {
  watchKind: SaleWatchKind;
  watchId: string;
  saleId: string;
  baselineSnapshot: SaleChangeSnapshot | null;
};

export type SaleChange = {
  eventKind: SaleChangeEventKind;
  severity: SaleChangeSeverity;
  summaryLabel: string;
  field: keyof SaleChangeSnapshot;
  previousValue: string | number | null;
  currentValue: string | number | null;
  fingerprint: string;
  /** Motif connu du changement (retrait déduit de l'absence de l'annonce à la source). */
  reason?: typeof SALE_CHANGE_REASON_SOURCE_ABSENCE;
};

export type SaleChangeEventSummary = {
  id: string;
  saleId: string;
  watchKind: SaleWatchKind;
  watchId: string;
  eventKind: SaleChangeEventKind;
  severity: SaleChangeSeverity;
  fingerprint: string;
  summaryLabel: string;
  changeSummary: Record<string, unknown>;
  detectedAt: string;
  readAt: string | null;
  dismissedAt: string | null;
};

export type SaleChangeEventListResponse = {
  events: SaleChangeEventSummary[];
};

export type SaleChangeMonitorResponse = {
  ok: true;
  monitoredAt: string;
  watchCount: number;
  saleCount: number;
  changeCount: number;
  insertedEventCount: number;
  baselineCount: number;
  events: SaleChangeEventSummary[];
};

export type SaleChangeMonitorBatchUserResult = {
  userId: string;
  ok: boolean;
  /** Compte sans droit au suivi (offre de lancement sans email confirmé, plan Découverte) : écarté, pas en échec. */
  skipped: boolean;
  watchCount: number;
  saleCount: number;
  changeCount: number;
  insertedEventCount: number;
  error: string | null;
};

export type SaleChangeMonitorBatchResult = {
  ok: true;
  startedAt: string;
  finishedAt: string;
  candidateUserCount: number;
  monitoredUserCount: number;
  skippedUserCount: number;
  failedUserCount: number;
  totalChangeCount: number;
  totalInsertedEventCount: number;
  results: SaleChangeMonitorBatchUserResult[];
};

type InvestorMonitorCandidate = {
  userId: string;
  userRole: "admin" | "user";
};

export const saleChangeEventActionSchema = z.object({
  eventId: z.string().uuid(),
  action: z.enum(["read", "unread", "dismiss", "restore"]),
});

const DEFAULT_SALE_CHANGE_EVENT_LIMIT = 80;
const MAX_SALE_CHANGE_EVENT_LIMIT = 250;
// Taille du lot des comptes SANS consentement aux rappels : ceux qui ont consenti sont tous examinés
// chaque jour, en plus de ce lot (voir `selectRotatingMonitorCandidates`).
const DEFAULT_SALE_CHANGE_MONITOR_USER_LIMIT = 25;
const MAX_SALE_CHANGE_MONITOR_USER_LIMIT = 100;
// Lecture des candidats par pages (identifiants seulement) pour pouvoir faire tourner le lot :
// sans cela, un tri fixe + limite ne verrait jamais que les mêmes profils.
const MONITOR_CANDIDATE_PAGE_SIZE = 1000;
const MONITOR_CANDIDATE_MAX_PAGES = 10;
// Part du lot gardée pour les comptes non prioritaires quand les prioritaires suffiraient à tout
// remplir (un quart), afin qu'ils ne soient jamais affamés.
const MONITOR_REST_RESERVE_RATIO = 0.25;
const DAY_MS = 86_400_000;
// Ventes lues par requête quand on cherche celles qui ont quitté le catalogue.
const LEFT_CATALOGUE_BATCH_SIZE = 100;

export async function listSaleChangeEvents({
  auth,
  limit = DEFAULT_SALE_CHANGE_EVENT_LIMIT,
  includeDismissed = false,
  saleId,
}: {
  auth: SupabaseAuthContext;
  limit?: number;
  includeDismissed?: boolean;
  /** Une seule vente (fiche de la vente : « plafond à vérifier ») ; absent : toutes les ventes suivies. */
  saleId?: string;
}): Promise<SaleChangeEventListResponse> {
  await assertRealtimeChangesAvailable(auth);

  let query = auth.supabase
    .from("user_sale_change_events")
    .select("*")
    .eq("user_id", auth.userId)
    .order("detected_at", { ascending: false })
    .limit(clampLimit(limit, MAX_SALE_CHANGE_EVENT_LIMIT));

  if (!includeDismissed) query = query.is("dismissed_at", null);
  if (saleId) query = query.eq("sale_id", saleId);

  const { data, error } = await query;
  if (error) throw error;

  const visibleSaleIds = await getPublicationVisibleSaleIds((data ?? []).map((row) => row.sale_id));

  return {
    events: (data ?? [])
      .filter((row) => visibleSaleIds.has(row.sale_id))
      .map(saleChangeEventRowToSummary),
  };
}

export async function updateSaleChangeEventState({
  auth,
  eventId,
  action,
}: {
  auth: SupabaseAuthContext;
  eventId: string;
  action: "read" | "unread" | "dismiss" | "restore";
}): Promise<{ event: SaleChangeEventSummary }> {
  await assertRealtimeChangesAvailable(auth);

  const now = new Date().toISOString();
  const patch: SaleChangeEventUpdate =
    action === "read"
      ? { read_at: now }
      : action === "unread"
        ? { read_at: null }
        : action === "dismiss"
          ? { dismissed_at: now }
          : { dismissed_at: null };

  const { data: existingEvent, error: existingEventError } = await auth.supabase
    .from("user_sale_change_events")
    .select("sale_id")
    .eq("id", eventId)
    .eq("user_id", auth.userId)
    .single();
  if (existingEventError) throw existingEventError;
  const existingVisibleSaleIds = await getPublicationVisibleSaleIds([existingEvent.sale_id]);
  if (!existingVisibleSaleIds.has(existingEvent.sale_id)) {
    throw new SalePublicationUnavailableError();
  }

  const { data, error } = await auth.supabase
    .from("user_sale_change_events")
    .update(patch)
    .eq("id", eventId)
    .eq("user_id", auth.userId)
    .select("*")
    .single();

  if (error) throw error;
  const visibleSaleIds = await getPublicationVisibleSaleIds([data.sale_id]);
  if (!visibleSaleIds.has(data.sale_id)) throw new SalePublicationUnavailableError();
  return { event: saleChangeEventRowToSummary(data) };
}

export async function monitorUserSaleChanges({
  auth,
  now = new Date(),
}: {
  auth: SupabaseAuthContext;
  now?: Date;
}): Promise<SaleChangeMonitorResponse> {
  await assertRealtimeChangesAvailable(auth);

  const monitoredAt = now.toISOString();
  const watches = await loadUserSaleWatches(auth);
  const saleIds = [...new Set(watches.map((watch) => watch.saleId))];
  const [sales, existingSnapshots] = await Promise.all([
    loadSalesByIds(auth, saleIds),
    loadExistingSnapshots(auth, saleIds),
  ]);
  const salesById = new Map(sales.map((sale) => [sale.id, sale]));
  // Une vente suivie qui n'est plus dans la vue du catalogue (retirée, annulée, adjugée) ne doit pas
  // disparaître en silence : c'est justement le changement que le consentement promet de signaler.
  const leftCatalogue = await loadGraveSalesOutsideCatalogue(
    saleIds.filter((saleId) => !salesById.has(saleId)),
  );
  const snapshotsByWatch = new Map(
    existingSnapshots.map((row) => [snapshotKey(row), normalizeSnapshot(row.snapshot)]),
  );
  const snapshotRows: SaleWatchSnapshotInsert[] = [];
  const eventRows: SaleChangeEventInsert[] = [];
  let baselineCount = 0;

  for (const watch of watches) {
    const sale = salesById.get(watch.saleId);
    const key = watchKey(watch);
    const previous = snapshotsByWatch.get(key) ?? watch.baselineSnapshot;
    if (!sale) {
      // Sans instantané précédent on ne sait pas ce qui a changé : rien à signaler, rien à écrire.
      const left = leftCatalogue.get(watch.saleId);
      if (!left || !previous) continue;
      const current: SaleChangeSnapshot = { ...previous, status: left.status };
      eventRows.push(
        ...detectSaleChanges({ previous, current, now, statusReason: left.reason })
          .filter((change) => change.eventKind === "status_changed")
          .map((change) =>
            buildSaleChangeEventInsert({
              userId: auth.userId,
              watch,
              change,
              previous,
              current,
              detectedAt: monitoredAt,
            }),
          ),
      );
      snapshotRows.push(buildSnapshotRow({ userId: auth.userId, watch, current, monitoredAt }));
      continue;
    }

    const current = buildSaleChangeSnapshot(sale);

    if (previous) {
      const changes = detectSaleChanges({ previous, current, now });
      eventRows.push(
        ...changes.map((change) =>
          buildSaleChangeEventInsert({
            userId: auth.userId,
            watch,
            change,
            previous,
            current,
            detectedAt: monitoredAt,
          }),
        ),
      );
    } else {
      baselineCount += 1;
    }

    snapshotRows.push(buildSnapshotRow({ userId: auth.userId, watch, current, monitoredAt }));
  }

  await upsertWatchSnapshots(snapshotRows);
  const insertedRows = await insertChangeEvents(eventRows);

  await recordFeatureUsageEvent({
    auth,
    eventKey: "sale_changes.monitored",
    subjectType: "sale_change_monitor",
    metadata: {
      watch_count: watches.length,
      sale_count: saleIds.length,
      change_count: eventRows.length,
      inserted_event_count: insertedRows.length,
      baseline_count: baselineCount,
    },
  });

  return {
    ok: true,
    monitoredAt,
    watchCount: watches.length,
    saleCount: saleIds.length,
    changeCount: eventRows.length,
    insertedEventCount: insertedRows.length,
    baselineCount,
    events: insertedRows.map(saleChangeEventRowToSummary),
  };
}

export async function runSaleChangeMonitorBatch({
  userLimit = DEFAULT_SALE_CHANGE_MONITOR_USER_LIMIT,
  now = new Date(),
}: {
  userLimit?: number;
  /** Date du passage : elle fixe la fenêtre tournante (un pas par jour UTC). */
  now?: Date;
} = {}): Promise<SaleChangeMonitorBatchResult> {
  const startedAt = new Date().toISOString();
  const candidates = await getInvestorUsers(
    clampLimit(userLimit, MAX_SALE_CHANGE_MONITOR_USER_LIMIT),
    now,
  );
  const results: SaleChangeMonitorBatchUserResult[] = [];

  for (const candidate of candidates) {
    const userId = candidate.userId;
    try {
      // Le vrai profil du compte (niveau et rôle), pas un niveau premium supposé : pendant l'offre de
      // lancement, le droit au suivi suit la même règle que partout ailleurs (profil ET email
      // confirmé, voir `resolvePlanEntitlements`). Un compte sans droit est écarté, pas en échec.
      const auth = await systemAuthForUser(userId);
      const plan = await resolvePlanEntitlements(auth);
      if (!featureIncluded(plan.plan, "alerts.realtimeChanges")) {
        results.push({
          userId,
          ok: true,
          skipped: true,
          watchCount: 0,
          saleCount: 0,
          changeCount: 0,
          insertedEventCount: 0,
          error: null,
        });
        continue;
      }
      const response = await monitorUserSaleChanges({ auth });
      results.push({
        userId,
        ok: true,
        skipped: false,
        watchCount: response.watchCount,
        saleCount: response.saleCount,
        changeCount: response.changeCount,
        insertedEventCount: response.insertedEventCount,
        error: null,
      });
    } catch (error) {
      results.push({
        userId,
        ok: false,
        skipped: false,
        watchCount: 0,
        saleCount: 0,
        changeCount: 0,
        insertedEventCount: 0,
        error: error instanceof Error ? error.message : "Monitoring impossible",
      });
    }
  }

  const result: SaleChangeMonitorBatchResult = {
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    candidateUserCount: candidates.length,
    monitoredUserCount: results.filter((result) => result.ok && !result.skipped).length,
    skippedUserCount: results.filter((result) => result.skipped).length,
    failedUserCount: results.filter((result) => !result.ok).length,
    totalChangeCount: results.reduce((total, result) => total + result.changeCount, 0),
    totalInsertedEventCount: results.reduce(
      (total, result) => total + result.insertedEventCount,
      0,
    ),
    results,
  };

  if (result.failedUserCount > 0) {
    const firstFailure = result.results.find((item) => !item.ok)?.error;
    throw new Error(
      `Le suivi des ventes a échoué pour ${result.failedUserCount}/${result.candidateUserCount} utilisateur(s)${firstFailure ? ` : ${firstFailure}` : "."}`,
    );
  }

  return result;
}

export function buildSaleChangeSnapshot(sale: AuctionSale): SaleChangeSnapshot {
  const documents = documentSignatureParts(sale);

  return {
    title: cleanString(sale.title),
    city: cleanString(sale.city),
    department: cleanString(sale.department),
    startingPriceEur: finiteNumber(sale.starting_price_eur),
    saleDate: cleanString(sale.sale_date),
    status: cleanString(sale.status),
    investmentScore: finiteNumber(sale.investment_score),
    documentCount: documents.count,
    documentSignature: documents.signature,
    updatedAt: cleanString(sale.updated_at),
    sourceUrl: cleanString(sale.source_url),
  };
}

export function detectSaleChanges({
  previous,
  current,
  now = new Date(),
  statusReason,
}: {
  previous: SaleChangeSnapshot;
  current: SaleChangeSnapshot;
  now?: Date;
  /**
   * Motif du changement de statut quand il est déduit de l'absence de l'annonce à sa source : le
   * changement est annoncé comme une annonce disparue à vérifier, pas comme un retrait, et n'est pas
   * « urgent ».
   */
  statusReason?: typeof SALE_CHANGE_REASON_SOURCE_ABSENCE | null;
}): SaleChange[] {
  const changes: SaleChange[] = [];
  addChangeIfDifferent(changes, {
    eventKind: "price_changed",
    field: "startingPriceEur",
    previous,
    current,
    summaryLabel: priceChangeLabel(previous.startingPriceEur, current.startingPriceEur),
    severity:
      previous.startingPriceEur != null &&
      current.startingPriceEur != null &&
      current.startingPriceEur < previous.startingPriceEur
        ? "important"
        : "info",
  });
  addChangeIfDifferent(changes, {
    eventKind: "audience_changed",
    field: "saleDate",
    previous,
    current,
    summaryLabel: "Date d'audience modifiée",
    severity: saleDateSeverity(current.saleDate, now),
  });
  addChangeIfDifferent(changes, {
    eventKind: "status_changed",
    field: "status",
    previous,
    current,
    summaryLabel: statusReason ? SOURCE_ABSENCE_LABEL : "Statut de la vente modifié",
    severity: statusReason ? "important" : statusSeverity(current.status),
    reason: statusReason ?? undefined,
  });
  addChangeIfDifferent(changes, {
    eventKind: "documents_changed",
    field: "documentSignature",
    previous,
    current,
    summaryLabel: documentChangeLabel(previous.documentCount, current.documentCount),
    severity: (current.documentCount ?? 0) > (previous.documentCount ?? 0) ? "important" : "info",
  });

  if (
    previous.investmentScore != null &&
    current.investmentScore != null &&
    Math.abs(current.investmentScore - previous.investmentScore) >= 5
  ) {
    addChangeIfDifferent(changes, {
      eventKind: "score_changed",
      field: "investmentScore",
      previous,
      current,
      summaryLabel: "Score de rentabilité modifié",
      severity:
        Math.abs(current.investmentScore - previous.investmentScore) >= 10 ? "important" : "info",
    });
  }

  return changes;
}

export function saleChangeEventRowToSummary(row: SaleChangeEventRow): SaleChangeEventSummary {
  return {
    id: row.id,
    saleId: row.sale_id,
    watchKind: row.watch_kind as SaleWatchKind,
    watchId: row.watch_id,
    eventKind: row.event_kind as SaleChangeEventKind,
    severity: row.severity as SaleChangeSeverity,
    fingerprint: row.fingerprint,
    summaryLabel: row.summary_label,
    changeSummary: asRecord(row.change_summary),
    detectedAt: row.detected_at,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
  };
}

function buildSaleChangeEventInsert({
  userId,
  watch,
  change,
  previous,
  current,
  detectedAt,
}: {
  userId: string;
  watch: SaleWatchSource;
  change: SaleChange;
  previous: SaleChangeSnapshot;
  current: SaleChangeSnapshot;
  detectedAt: string;
}): SaleChangeEventInsert {
  return {
    user_id: userId,
    sale_id: watch.saleId,
    watch_kind: watch.watchKind,
    watch_id: watch.watchId,
    event_kind: change.eventKind,
    severity: change.severity,
    fingerprint: change.fingerprint,
    summary_label: change.summaryLabel,
    old_snapshot: asJson(previous),
    new_snapshot: asJson(current),
    change_summary: asJson({
      field: change.field,
      previousValue: change.previousValue,
      currentValue: change.currentValue,
      ...(change.reason ? { reason: change.reason } : {}),
    }),
    detected_at: detectedAt,
  };
}

function addChangeIfDifferent(
  changes: SaleChange[],
  args: {
    eventKind: SaleChangeEventKind;
    field: keyof SaleChangeSnapshot;
    previous: SaleChangeSnapshot;
    current: SaleChangeSnapshot;
    summaryLabel: string;
    severity: SaleChangeSeverity;
    reason?: typeof SALE_CHANGE_REASON_SOURCE_ABSENCE;
  },
) {
  const previousValue = args.previous[args.field];
  const currentValue = args.current[args.field];

  if (previousValue == null || currentValue == null || previousValue === currentValue) return;

  const fingerprint = [
    args.eventKind,
    args.field,
    String(previousValue),
    String(currentValue),
  ].join(":");

  changes.push({
    eventKind: args.eventKind,
    severity: args.severity,
    summaryLabel: args.summaryLabel,
    field: args.field,
    previousValue,
    currentValue,
    fingerprint,
    ...(args.reason ? { reason: args.reason } : {}),
  });
}

async function assertRealtimeChangesAvailable(auth: SupabaseAuthContext) {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "alerts.realtimeChanges")) {
    throw new Error("Suivi temps réel des changements réservé à l’offre Analyse.");
  }
}

async function loadUserSaleWatches(auth: SupabaseAuthContext): Promise<SaleWatchSource[]> {
  const [alertMatches, favorites, workspaces] = await Promise.all([
    loadAlertMatchWatches(auth),
    loadFavoriteWatches(auth),
    loadWorkspaceWatches(auth),
  ]);

  return [
    ...alertMatches.map((row) => ({
      watchKind: "alert_match" as const,
      watchId: row.id,
      saleId: row.sale_id,
      baselineSnapshot: snapshotFromAlertMatch(row),
    })),
    ...favorites.map((row) => ({
      watchKind: "favorite" as const,
      watchId: row.id,
      saleId: row.sale_id,
      baselineSnapshot: null,
    })),
    ...workspaces.map((row) => ({
      watchKind: "workspace" as const,
      watchId: row.id,
      saleId: row.sale_id,
      baselineSnapshot: null,
    })),
  ];
}

async function loadAlertMatchWatches(auth: SupabaseAuthContext): Promise<AlertMatchWatchRow[]> {
  const { data, error } = await auth.supabase
    .from("user_alert_matches")
    .select("id,sale_id,match_snapshot,matched_at")
    .eq("user_id", auth.userId)
    .is("dismissed_at", null)
    .order("matched_at", { ascending: false })
    .limit(500);

  if (error) throw error;
  return data ?? [];
}

async function loadFavoriteWatches(auth: SupabaseAuthContext): Promise<FavoriteWatchRow[]> {
  const { data, error } = await auth.supabase
    .from("user_favorites")
    .select("id,sale_id,created_at")
    .eq("user_id", auth.userId)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) throw error;
  return data ?? [];
}

async function loadWorkspaceWatches(auth: SupabaseAuthContext): Promise<WorkspaceWatchRow[]> {
  const { data, error } = await auth.supabase
    .from("sale_workspaces")
    .select("id,sale_id,updated_at")
    .eq("user_id", auth.userId)
    .neq("tracking_status", "archived")
    .order("updated_at", { ascending: false })
    .limit(500);

  if (error) throw error;
  return data ?? [];
}

async function loadExistingSnapshots(
  auth: SupabaseAuthContext,
  saleIds: string[],
): Promise<SaleWatchSnapshotRow[]> {
  if (!saleIds.length) return [];

  const { data, error } = await auth.supabase
    .from("user_sale_watch_snapshots")
    .select("*")
    .eq("user_id", auth.userId)
    .in("sale_id", saleIds);

  if (error) throw error;
  return data ?? [];
}

async function loadSalesByIds(
  auth: SupabaseAuthContext,
  saleIds: string[],
): Promise<AuctionSale[]> {
  const ids = [...new Set(saleIds)].filter(Boolean);
  if (!ids.length) return [];

  const { data, error } = await auth.supabase
    .from(DETAIL_VIEW)
    .select(SALE_LIST_COLUMNS)
    .in("id", ids);

  if (error) throw error;
  const rows = saleRows(data);
  const visibleSaleIds = await getPublicationVisibleSaleIds(rows.map((sale) => sale.id));
  return rows.filter((sale) => visibleSaleIds.has(sale.id));
}

/**
 * Parmi les ventes suivies absentes de la vue du catalogue (`v_auction_sales_app` ne garde que les
 * statuts à venir), celles dont le statut est grave : retirée, annulée, adjugée (ou reportée). La
 * lecture est faite sur la table avec le rôle de service : elle applique donc elle-même la garde de
 * quarantaine, une vente en quarantaine ne produit jamais d'événement. Les autres ventes absentes
 * (fin de validité au catalogue, par exemple) restent muettes.
 */
async function loadGraveSalesOutsideCatalogue(
  saleIds: string[],
): Promise<
  Map<string, { status: string; reason: typeof SALE_CHANGE_REASON_SOURCE_ABSENCE | null }>
> {
  const result = new Map<
    string,
    { status: string; reason: typeof SALE_CHANGE_REASON_SOURCE_ABSENCE | null }
  >();
  const ids = [...new Set(saleIds)].filter(Boolean);
  for (let start = 0; start < ids.length; start += LEFT_CATALOGUE_BATCH_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("auction_sales")
      .select(
        `id,sale_date,${PUBLICATION_QUARANTINE_SELECT},source_absence:raw_payload->source_absence` as const,
      )
      .in("id", ids.slice(start, start + LEFT_CATALOGUE_BATCH_SIZE));
    if (error) throw error;
    for (const row of data ?? []) {
      if (typeof row.id !== "string" || isPublicationQuarantinedGuardRow(row)) continue;
      const status = cleanString(row.status)?.toLowerCase();
      if (status && GRAVE_SALE_STATUSES.has(status)) {
        result.set(row.id, {
          status,
          reason: withdrawnBySourceAbsence(status, row.source_absence),
        });
      }
    }
  }
  return result;
}

/**
 * « Retirée » par `withdraw_missing_source_sales` : la vente a été passée en `withdrawn` parce qu'elle
 * manquait aux deux derniers inventaires complets de sa source (`raw_payload.source_absence`). C'est
 * une absence, pas un retrait annoncé par la source.
 */
function withdrawnBySourceAbsence(
  status: string,
  sourceAbsence: unknown,
): typeof SALE_CHANGE_REASON_SOURCE_ABSENCE | null {
  const isObject =
    sourceAbsence !== null && typeof sourceAbsence === "object" && !Array.isArray(sourceAbsence);
  return status === "withdrawn" && isObject ? SALE_CHANGE_REASON_SOURCE_ABSENCE : null;
}

function buildSnapshotRow({
  userId,
  watch,
  current,
  monitoredAt,
}: {
  userId: string;
  watch: SaleWatchSource;
  current: SaleChangeSnapshot;
  monitoredAt: string;
}): SaleWatchSnapshotInsert {
  return {
    user_id: userId,
    sale_id: watch.saleId,
    watch_kind: watch.watchKind,
    watch_id: watch.watchId,
    snapshot: asJson(current),
    fingerprint: snapshotFingerprint(current),
    last_checked_at: monitoredAt,
    updated_at: monitoredAt,
  };
}

async function upsertWatchSnapshots(rows: SaleWatchSnapshotInsert[]) {
  if (!rows.length) return;

  const { error } = await supabaseAdmin
    .from("user_sale_watch_snapshots")
    .upsert(rows, { onConflict: "user_id,sale_id,watch_kind,watch_id" });

  if (error) throw error;
}

async function insertChangeEvents(rows: SaleChangeEventInsert[]): Promise<SaleChangeEventRow[]> {
  if (!rows.length) return [];

  const { data, error } = await supabaseAdmin
    .from("user_sale_change_events")
    .upsert(rows, {
      onConflict: "user_id,sale_id,event_kind,fingerprint",
      ignoreDuplicates: true,
    })
    .select("*");

  if (error) throw error;
  return data ?? [];
}

type MonitorCandidate = InvestorMonitorCandidate & {
  /** Administrateur, premium ou abonné Analyse. */
  priority: boolean;
  /** A consenti aux rappels d'audience : examiné chaque jour, sans passer par la rotation. */
  consented?: boolean;
};

/** Lit toutes les pages d'une requête d'identifiants, dans la limite de `MONITOR_CANDIDATE_MAX_PAGES`. */
async function readCandidatePages<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let index = 0; index < MONITOR_CANDIDATE_MAX_PAGES; index += 1) {
    const from = index * MONITOR_CANDIDATE_PAGE_SIZE;
    const { data, error } = await page(from, from + MONITOR_CANDIDATE_PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < MONITOR_CANDIDATE_PAGE_SIZE) break;
  }
  return rows;
}

/**
 * Fenêtre tournante sur un anneau trié : le jour J lit les positions J*quota à J*quota+quota-1
 * (modulo la taille), donc des passages successifs avancent sans trou ni répétition. Le passage de
 * rattrapage du même jour retombe sur la même fenêtre, ce qui est voulu.
 */
function rotatingWindow<T>(ring: T[], quota: number, now: Date): T[] {
  if (quota <= 0 || !ring.length) return [];
  if (quota >= ring.length) return ring;
  const day = Math.floor(now.getTime() / DAY_MS);
  const start = (day * quota) % ring.length;
  return Array.from({ length: quota }, (_, index) => ring[(start + index) % ring.length]);
}

/**
 * Choisit les comptes du passage. Les comptes qui ont consenti aux rappels d'audience sont TOUS pris,
 * chaque jour : leur avertissement (vente retirée, date modifiée) ne doit dépendre d'aucune rotation.
 * Ils s'ajoutent au lot de `limit` comptes tourné pour les autres : les prioritaires (abonnés,
 * premium, administrateurs) passent d'abord, un quart du lot reste réservé aux autres, et dans
 * chaque groupe la fenêtre tourne chaque jour.
 */
export function selectRotatingMonitorCandidates({
  candidates,
  limit,
  now,
}: {
  candidates: MonitorCandidate[];
  limit: number;
  now: Date;
}): InvestorMonitorCandidate[] {
  const byUserId = (a: MonitorCandidate, b: MonitorCandidate) => a.userId.localeCompare(b.userId);
  const consented = candidates.filter((candidate) => candidate.consented).sort(byUserId);
  const others = candidates.filter((candidate) => !candidate.consented);
  const priority = others.filter((candidate) => candidate.priority).sort(byUserId);
  const rest = others.filter((candidate) => !candidate.priority).sort(byUserId);
  const reserve = rest.length ? Math.floor(limit * MONITOR_REST_RESERVE_RATIO) : 0;
  const priorityQuota = Math.min(priority.length, limit - reserve);
  const restQuota = Math.min(rest.length, limit - priorityQuota);
  return [
    ...consented,
    ...rotatingWindow(priority, priorityQuota, now),
    ...rotatingWindow(rest, restQuota, now),
  ].map(({ userId, userRole }) => ({ userId, userRole }));
}

async function getInvestorUsers(limit: number, now: Date): Promise<InvestorMonitorCandidate[]> {
  // Offre de lancement : tout compte qui a un profil a le suivi des changements d'Analyse, donc
  // tous les profils sont candidats. Sans l'offre, seuls les comptes premium ou administrateurs
  // le sont, plus les abonnés Analyse ci-dessous. Le lot est ensuite tiré en rotation : le cron
  // ne modifie pas `updated_at`, un tri sur cette colonne rendrait toujours les mêmes profils.
  const launchOffer = await isLaunchOfferActive();
  const profilesQuery = supabaseAdmin
    .from("user_profiles")
    .select("user_id,account_tier,user_role");
  const [profiles, subscriptions, consents] = await Promise.all([
    readCandidatePages((from, to) =>
      (launchOffer ? profilesQuery : profilesQuery.or("account_tier.eq.premium,user_role.eq.admin"))
        .order("user_id", { ascending: true })
        .range(from, to),
    ),
    readCandidatePages((from, to) =>
      supabaseAdmin
        .from("user_subscriptions")
        .select("user_id,plan_code,status,current_period_end")
        .eq("plan_code", "analyse")
        .order("user_id", { ascending: true })
        .range(from, to),
    ),
    readCandidatePages((from, to) =>
      supabaseAdmin
        .from("user_notification_preferences")
        .select("user_id")
        .eq("sale_reminders_enabled", true)
        .order("user_id", { ascending: true })
        .range(from, to),
    ),
  ]);

  const consented = new Set(consents.map((row) => row.user_id));
  const candidates = new Map<string, MonitorCandidate>();
  for (const profile of profiles) {
    const userRole = profile.user_role === "admin" ? "admin" : "user";
    candidates.set(profile.user_id, {
      userId: profile.user_id,
      userRole,
      priority: userRole === "admin" || profile.account_tier === "premium",
      consented: consented.has(profile.user_id),
    });
  }
  for (const subscription of subscriptions.filter((row) =>
    isPlanPeriodActive(row.status, row.current_period_end),
  )) {
    const existing = candidates.get(subscription.user_id);
    if (existing) existing.priority = true;
    else
      candidates.set(subscription.user_id, {
        userId: subscription.user_id,
        userRole: "user",
        priority: true,
      });
  }
  return selectRotatingMonitorCandidates({ candidates: [...candidates.values()], limit, now });
}

function snapshotFromAlertMatch(row: AlertMatchWatchRow): SaleChangeSnapshot | null {
  const snapshot = asRecord(row.match_snapshot);
  const sale = asRecord(snapshot.sale);
  if (!sale.id && !sale.startingPriceEur && !sale.saleDate) return null;

  return normalizeSnapshot({
    title: sale.title,
    city: sale.city,
    department: sale.department,
    startingPriceEur: sale.startingPriceEur,
    saleDate: sale.saleDate,
    status: sale.status,
    investmentScore: sale.investmentScore,
    documentCount: sale.documentCount,
    documentSignature: sale.documentSignature,
    updatedAt: sale.updatedAt,
    sourceUrl: sale.sourceUrl,
  });
}

function normalizeSnapshot(value: unknown): SaleChangeSnapshot {
  const record = asRecord(value);
  return {
    title: stringValue(record.title),
    city: stringValue(record.city),
    department: stringValue(record.department),
    startingPriceEur: numberValue(record.startingPriceEur),
    saleDate: stringValue(record.saleDate),
    status: stringValue(record.status),
    investmentScore: numberValue(record.investmentScore),
    documentCount: numberValue(record.documentCount),
    documentSignature: stringValue(record.documentSignature),
    updatedAt: stringValue(record.updatedAt),
    sourceUrl: stringValue(record.sourceUrl),
  };
}

function documentSignatureParts(sale: AuctionSale): { count: number; signature: string | null } {
  const values = Array.isArray(sale.documents_rich)
    ? sale.documents_rich.map((document) =>
        [
          document.url,
          document.label,
          document.type ?? document.document_type,
          document.extraction_status,
        ]
          .filter(Boolean)
          .join("|"),
      )
    : primitiveDocumentValues(sale.documents);

  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  return {
    count: unique.length,
    signature: unique.length ? unique.join("||") : null,
  };
}

function primitiveDocumentValues(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(primitiveDocumentValues);
  if (typeof value === "object") return Object.values(value).flatMap(primitiveDocumentValues);
  return [];
}

function priceChangeLabel(previous: number | null, current: number | null): string {
  if (previous != null && current != null && current < previous) return "Mise à prix abaissée";
  if (previous != null && current != null && current > previous) return "Mise à prix augmentée";
  return "Mise à prix modifiée";
}

function documentChangeLabel(previous: number | null, current: number | null): string {
  if (previous != null && current != null && current > previous) return "Nouveau document détecté";
  if (previous != null && current != null && current < previous) return "Document retiré";
  return "Documents modifiés";
}

function saleDateSeverity(value: string | null, now: Date): SaleChangeSeverity {
  if (!value) return "important";
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return "important";
  const dayMs = 24 * 60 * 60 * 1000;
  return date - now.getTime() <= 14 * dayMs ? "urgent" : "important";
}

function statusSeverity(value: string | null): SaleChangeSeverity {
  if (!value) return "important";
  return /annul|adjud|vend|report|cancel|sold|retir|withdraw/i.test(value) ? "urgent" : "important";
}

function snapshotFingerprint(snapshot: SaleChangeSnapshot): string {
  return [
    snapshot.startingPriceEur,
    snapshot.saleDate,
    snapshot.status,
    snapshot.investmentScore,
    snapshot.documentSignature,
  ]
    .map((value) => String(value ?? ""))
    .join("|");
}

function watchKey(watch: SaleWatchSource): string {
  return `${watch.watchKind}:${watch.watchId}`;
}

function snapshotKey(row: SaleWatchSnapshotRow): string {
  return `${row.watch_kind}:${row.watch_id}`;
}

function clampLimit(value: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(value || 1)));
}

function cleanString(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
