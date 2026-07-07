import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { featureIncluded, isActivePlanStatus } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { DETAIL_VIEW, SALE_LIST_COLUMNS } from "@/lib/queries";
import type { AuctionSale } from "@/lib/types";
import { recordFeatureUsageEvent } from "@/lib/usage";

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
  failedUserCount: number;
  totalChangeCount: number;
  totalInsertedEventCount: number;
  results: SaleChangeMonitorBatchUserResult[];
};

export const saleChangeEventActionSchema = z.object({
  eventId: z.string().uuid(),
  action: z.enum(["read", "unread", "dismiss", "restore"]),
});

const DEFAULT_SALE_CHANGE_EVENT_LIMIT = 80;
const MAX_SALE_CHANGE_EVENT_LIMIT = 250;
const DEFAULT_SALE_CHANGE_MONITOR_USER_LIMIT = 25;
const MAX_SALE_CHANGE_MONITOR_USER_LIMIT = 100;

export async function listSaleChangeEvents({
  auth,
  limit = DEFAULT_SALE_CHANGE_EVENT_LIMIT,
  includeDismissed = false,
}: {
  auth: SupabaseAuthContext;
  limit?: number;
  includeDismissed?: boolean;
}): Promise<SaleChangeEventListResponse> {
  await assertRealtimeChangesAvailable(auth);

  let query = auth.supabase
    .from("user_sale_change_events")
    .select("*")
    .eq("user_id", auth.userId)
    .order("detected_at", { ascending: false })
    .limit(clampLimit(limit, MAX_SALE_CHANGE_EVENT_LIMIT));

  if (!includeDismissed) query = query.is("dismissed_at", null);

  const { data, error } = await query;
  if (error) throw error;

  return { events: (data ?? []).map(saleChangeEventRowToSummary) };
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

  const { data, error } = await auth.supabase
    .from("user_sale_change_events")
    .update(patch)
    .eq("id", eventId)
    .eq("user_id", auth.userId)
    .select("*")
    .single();

  if (error) throw error;
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
  const snapshotsByWatch = new Map(
    existingSnapshots.map((row) => [snapshotKey(row), normalizeSnapshot(row.snapshot)]),
  );
  const snapshotRows: SaleWatchSnapshotInsert[] = [];
  const eventRows: SaleChangeEventInsert[] = [];
  let baselineCount = 0;

  for (const watch of watches) {
    const sale = salesById.get(watch.saleId);
    if (!sale) continue;

    const current = buildSaleChangeSnapshot(sale);
    const key = watchKey(watch);
    const previous = snapshotsByWatch.get(key) ?? watch.baselineSnapshot;

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

    snapshotRows.push({
      user_id: auth.userId,
      sale_id: watch.saleId,
      watch_kind: watch.watchKind,
      watch_id: watch.watchId,
      snapshot: asJson(current),
      fingerprint: snapshotFingerprint(current),
      last_checked_at: monitoredAt,
      updated_at: monitoredAt,
    });
  }

  await upsertWatchSnapshots(auth, snapshotRows);
  const insertedRows = await insertChangeEvents(auth, eventRows);

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
}: {
  userLimit?: number;
} = {}): Promise<SaleChangeMonitorBatchResult> {
  const startedAt = new Date().toISOString();
  const candidateUserIds = await getInvestorUserIds(
    clampLimit(userLimit, MAX_SALE_CHANGE_MONITOR_USER_LIMIT),
  );
  const results: SaleChangeMonitorBatchUserResult[] = [];

  for (const userId of candidateUserIds) {
    try {
      const response = await monitorUserSaleChanges({
        auth: systemAuthForUser(userId),
      });
      results.push({
        userId,
        ok: true,
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
        watchCount: 0,
        saleCount: 0,
        changeCount: 0,
        insertedEventCount: 0,
        error: error instanceof Error ? error.message : "Monitoring impossible",
      });
    }
  }

  return {
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    candidateUserCount: candidateUserIds.length,
    monitoredUserCount: results.filter((result) => result.ok).length,
    failedUserCount: results.filter((result) => !result.ok).length,
    totalChangeCount: results.reduce((total, result) => total + result.changeCount, 0),
    totalInsertedEventCount: results.reduce(
      (total, result) => total + result.insertedEventCount,
      0,
    ),
    results,
  };
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
}: {
  previous: SaleChangeSnapshot;
  current: SaleChangeSnapshot;
  now?: Date;
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
    summaryLabel: "Statut de la vente modifié",
    severity: statusSeverity(current.status),
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
    watchKind: row.watch_kind,
    watchId: row.watch_id,
    eventKind: row.event_kind,
    severity: row.severity,
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
  });
}

async function assertRealtimeChangesAvailable(auth: SupabaseAuthContext) {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "alerts.realtimeChanges")) {
    throw new Error("Suivi temps réel des changements réservé au plan Investisseur.");
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
  return (data ?? []) as unknown as AuctionSale[];
}

async function upsertWatchSnapshots(auth: SupabaseAuthContext, rows: SaleWatchSnapshotInsert[]) {
  if (!rows.length) return;

  const { error } = await auth.supabase
    .from("user_sale_watch_snapshots")
    .upsert(rows, { onConflict: "user_id,sale_id,watch_kind,watch_id" });

  if (error) throw error;
}

async function insertChangeEvents(
  auth: SupabaseAuthContext,
  rows: SaleChangeEventInsert[],
): Promise<SaleChangeEventRow[]> {
  if (!rows.length) return [];

  const { data, error } = await auth.supabase
    .from("user_sale_change_events")
    .upsert(rows, {
      onConflict: "user_id,sale_id,event_kind,fingerprint",
      ignoreDuplicates: true,
    })
    .select("*");

  if (error) throw error;
  return data ?? [];
}

async function getInvestorUserIds(limit: number): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("user_subscriptions")
    .select("user_id,plan_code,status")
    .eq("plan_code", "investisseur")
    .order("updated_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return (data ?? [])
    .filter((subscription) => isActivePlanStatus(subscription.status))
    .map((subscription) => subscription.user_id);
}

function systemAuthForUser(userId: string): SupabaseAuthContext {
  return {
    supabase: supabaseAdmin,
    userId,
    claims: {},
  };
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
  return /annul|adjud|vend|report|cancel|sold/i.test(value) ? "urgent" : "important";
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
