import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { featureAccess, featureIncluded, type FeatureAccess, type PlanCode } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { DETAIL_VIEW, SALE_LIST_COLUMNS } from "@/lib/queries";
import {
  DEFAULT_SALE_CHECKLIST,
  DOCUMENT_REVIEW_STATUSES,
  SALE_WORKSPACE_STATUS_LABELS,
  type SaleWorkspaceDocumentReviewStatus,
} from "@/lib/sale-workspace-shared";
import { normalizeWorkspace, type SaleWorkspace } from "@/lib/sale-workspaces";
import type { AuctionSale } from "@/lib/types";
import { recordFeatureUsageEvent } from "@/lib/usage";

const AUDIENCE_TRACKING_WORKSPACE_LIMIT = 200;

type SaleWorkspaceRow = Database["public"]["Tables"]["sale_workspaces"]["Row"];

export type AudienceTrackingUrgency = "past" | "today" | "week" | "month" | "later" | "unknown";
export type AudienceTrackingActionStatus = "none" | "overdue" | "due_soon" | "scheduled";
export type AudienceTrackingReadiness =
  | "ready"
  | "needs_work"
  | "urgent"
  | "blocked"
  | "missing_date"
  | "past"
  | "closed"
  | "archived";

export type AudienceTrackingChecklistMetrics = {
  total: number;
  done: number;
  open: number;
  progressPct: number;
};

export type AudienceTrackingDocumentMetrics = {
  expected: number;
  tracked: number;
  total: number;
  reviewed: number;
  open: number;
  questions: number;
  blocked: number;
  priorityOpen: number;
  progressPct: number;
  byStatus: Record<SaleWorkspaceDocumentReviewStatus, number>;
};

export type AudienceTrackingItem = {
  workspaceId: string;
  saleId: string;
  title: string | null;
  city: string | null;
  department: string | null;
  tribunal: string | null;
  startingPriceEur: number | null;
  saleDate: string | null;
  daysUntilAudience: number | null;
  audienceUrgency: AudienceTrackingUrgency;
  trackingStatus: SaleWorkspace["tracking_status"];
  trackingStatusLabel: string;
  nextAction: string | null;
  nextActionDueAt: string | null;
  actionStatus: AudienceTrackingActionStatus;
  checklist: AudienceTrackingChecklistMetrics;
  documents: AudienceTrackingDocumentMetrics;
  readiness: AudienceTrackingReadiness;
  readinessLabel: string;
  priorityScore: number;
};

export type AudienceTrackingSummary = {
  totalWorkspaces: number;
  activeWorkspaces: number;
  upcomingAudiences: number;
  pastAudiences: number;
  missingAudienceDates: number;
  nextAudienceAt: string | null;
  nextActionDueAt: string | null;
  readyToBid: number;
  urgentWorkspaces: number;
  blockedWorkspaces: number;
  overdueActions: number;
  dueSoonActions: number;
  completedChecklistItems: number;
  openChecklistItems: number;
  checklistProgressPct: number;
  trackedDocuments: number;
  reviewedDocuments: number;
  openDocuments: number;
  documentQuestions: number;
  documentBlockers: number;
};

export type AudienceTrackingPlanAccess = {
  code: PlanCode;
  label: string;
  feature: FeatureAccess;
};

export type AudienceTrackingResponse = {
  summary: AudienceTrackingSummary;
  items: AudienceTrackingItem[];
  sections: {
    priority: AudienceTrackingItem[];
    upcoming: AudienceTrackingItem[];
    ready: AudienceTrackingItem[];
  };
  plan: AudienceTrackingPlanAccess;
  meta: {
    generatedAt: string;
    sourceLimit: number;
    capped: boolean;
    includeArchived: boolean;
  };
};

export async function getAudienceTracking({
  auth,
  includeArchived = false,
}: {
  auth: SupabaseAuthContext;
  includeArchived?: boolean;
}): Promise<AudienceTrackingResponse> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "workspace.audienceTracking")) {
    throw new Error("Suivi d'audience réservé au plan Analyse.");
  }

  const workspaceRows = await loadWorkspaceRows(auth, includeArchived);
  const workspaces = workspaceRows.map(normalizeWorkspace);
  const sales = await loadSalesByIds(
    auth,
    workspaces.map((workspace) => workspace.sale_id),
  );
  const response = buildAudienceTrackingResponse({
    workspaces,
    sales,
    includeArchived,
    capped: workspaceRows.length >= AUDIENCE_TRACKING_WORKSPACE_LIMIT,
    plan: {
      code: plan.plan,
      label: plan.label,
      feature: featureAccess(plan.plan, "workspace.audienceTracking"),
    },
  });

  await recordFeatureUsageEvent({
    auth,
    eventKey: "workspace.audience_tracking_viewed",
    subjectType: "workspace_dashboard",
    metadata: {
      total_workspaces: response.summary.totalWorkspaces,
      urgent_workspaces: response.summary.urgentWorkspaces,
      overdue_actions: response.summary.overdueActions,
      include_archived: includeArchived,
    },
  });

  return response;
}

export function buildAudienceTrackingResponse({
  workspaces,
  sales,
  includeArchived = false,
  capped = false,
  now = new Date(),
  plan = {
    code: "analyse",
    label: "Analyse",
    feature: "included",
  },
}: {
  workspaces: SaleWorkspace[];
  sales: AuctionSale[];
  includeArchived?: boolean;
  capped?: boolean;
  now?: Date;
  plan?: AudienceTrackingPlanAccess;
}): AudienceTrackingResponse {
  const salesById = new Map(sales.map((sale) => [sale.id, sale]));
  const items = workspaces
    .flatMap((workspace) => {
      const sale = salesById.get(workspace.sale_id);
      if (!sale) return [];
      return [buildAudienceTrackingItem({ workspace, sale, now })];
    })
    .sort(compareAudienceTrackingItems);

  return {
    summary: buildAudienceTrackingSummary(items),
    items,
    sections: {
      priority: items.filter(isPriorityItem).slice(0, 8),
      upcoming: [...items]
        .filter((item) => item.daysUntilAudience != null && item.daysUntilAudience >= 0)
        .sort(compareByAudienceDate)
        .slice(0, 8),
      ready: items.filter((item) => item.readiness === "ready").slice(0, 8),
    },
    plan,
    meta: {
      generatedAt: now.toISOString(),
      sourceLimit: AUDIENCE_TRACKING_WORKSPACE_LIMIT,
      capped,
      includeArchived,
    },
  };
}

export function buildAudienceTrackingItem({
  workspace,
  sale,
  now = new Date(),
}: {
  workspace: SaleWorkspace;
  sale: AuctionSale;
  now?: Date;
}): AudienceTrackingItem {
  const daysUntilAudience = daysUntil(sale.sale_date, now);
  const audienceUrgency = resolveAudienceUrgency(daysUntilAudience);
  const actionStatus = resolveActionStatus(workspace.next_action_due_at, now);
  const checklist = buildChecklistMetrics(workspace);
  const documents = buildDocumentMetrics(workspace, sale);
  const readiness = resolveReadiness({
    trackingStatus: workspace.tracking_status,
    daysUntilAudience,
    actionStatus,
    checklist,
    documents,
  });

  return {
    workspaceId: workspace.id,
    saleId: sale.id,
    title: sale.title,
    city: sale.city,
    department: sale.department,
    tribunal: sale.tribunal_name ?? sale.tribunal,
    startingPriceEur: sale.starting_price_eur,
    saleDate: sale.sale_date,
    daysUntilAudience,
    audienceUrgency,
    trackingStatus: workspace.tracking_status,
    trackingStatusLabel: SALE_WORKSPACE_STATUS_LABELS[workspace.tracking_status],
    nextAction: workspace.next_action,
    nextActionDueAt: workspace.next_action_due_at,
    actionStatus,
    checklist,
    documents,
    readiness,
    readinessLabel: readinessLabel(readiness),
    priorityScore: priorityScore({
      readiness,
      actionStatus,
      daysUntilAudience,
      checklist,
      documents,
    }),
  };
}

function buildAudienceTrackingSummary(items: AudienceTrackingItem[]): AudienceTrackingSummary {
  const upcomingDates = items
    .filter((item) => item.daysUntilAudience != null && item.daysUntilAudience >= 0)
    .map((item) => item.saleDate)
    .filter((date): date is string => Boolean(date))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const dueDates = items
    .map((item) => item.nextActionDueAt)
    .filter((date): date is string => Boolean(date))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const completedChecklistItems = sum(items.map((item) => item.checklist.done));
  const checklistTotal = sum(items.map((item) => item.checklist.total));
  const reviewedDocuments = sum(items.map((item) => item.documents.reviewed));
  const trackedDocuments = sum(items.map((item) => item.documents.total));

  return {
    totalWorkspaces: items.length,
    activeWorkspaces: items.filter((item) => isActiveTrackingStatus(item.trackingStatus)).length,
    upcomingAudiences: upcomingDates.length,
    pastAudiences: items.filter((item) => item.audienceUrgency === "past").length,
    missingAudienceDates: items.filter((item) => item.audienceUrgency === "unknown").length,
    nextAudienceAt: upcomingDates[0] ?? null,
    nextActionDueAt: dueDates[0] ?? null,
    readyToBid: items.filter((item) => item.readiness === "ready").length,
    urgentWorkspaces: items.filter((item) => item.readiness === "urgent").length,
    blockedWorkspaces: items.filter((item) => item.readiness === "blocked").length,
    overdueActions: items.filter((item) => item.actionStatus === "overdue").length,
    dueSoonActions: items.filter((item) => item.actionStatus === "due_soon").length,
    completedChecklistItems,
    openChecklistItems: sum(items.map((item) => item.checklist.open)),
    checklistProgressPct: pct(completedChecklistItems, checklistTotal),
    trackedDocuments,
    reviewedDocuments,
    openDocuments: sum(items.map((item) => item.documents.open)),
    documentQuestions: sum(items.map((item) => item.documents.questions)),
    documentBlockers: sum(items.map((item) => item.documents.blocked)),
  };
}

function buildChecklistMetrics(workspace: SaleWorkspace): AudienceTrackingChecklistMetrics {
  const keys = new Set<string>([...DEFAULT_SALE_CHECKLIST, ...Object.keys(workspace.checklist)]);
  const total = keys.size;
  const done = [...keys].filter((key) => workspace.checklist[key] === true).length;

  return {
    total,
    done,
    open: Math.max(0, total - done),
    progressPct: pct(done, total),
  };
}

function buildDocumentMetrics(
  workspace: SaleWorkspace,
  sale: AuctionSale,
): AudienceTrackingDocumentMetrics {
  const reviews = Object.values(workspace.document_reviews);
  const byStatus = DOCUMENT_REVIEW_STATUSES.reduce(
    (acc, status) => {
      acc[status] = 0;
      return acc;
    },
    {} as Record<SaleWorkspaceDocumentReviewStatus, number>,
  );

  for (const review of reviews) {
    byStatus[review.status] += 1;
  }

  const expected = countSaleDocuments(sale);
  const tracked = reviews.length;
  const total = Math.max(expected, tracked);
  const reviewed = byStatus.reviewed;

  return {
    expected,
    tracked,
    total,
    reviewed,
    open: Math.max(0, total - reviewed),
    questions: byStatus.question,
    blocked: byStatus.blocked,
    priorityOpen: reviews.filter((review) => review.priority && review.status !== "reviewed")
      .length,
    progressPct: pct(reviewed, total),
    byStatus,
  };
}

function resolveReadiness({
  trackingStatus,
  daysUntilAudience,
  actionStatus,
  checklist,
  documents,
}: {
  trackingStatus: SaleWorkspace["tracking_status"];
  daysUntilAudience: number | null;
  actionStatus: AudienceTrackingActionStatus;
  checklist: AudienceTrackingChecklistMetrics;
  documents: AudienceTrackingDocumentMetrics;
}): AudienceTrackingReadiness {
  if (trackingStatus === "archived") return "archived";
  if (trackingStatus === "won" || trackingStatus === "lost") return "closed";
  if (daysUntilAudience == null) return "missing_date";
  if (daysUntilAudience < 0) return "past";
  if (documents.blocked > 0) return "blocked";
  if (
    actionStatus === "overdue" ||
    (daysUntilAudience <= 7 &&
      (checklist.open > 0 ||
        documents.open > 0 ||
        documents.questions > 0 ||
        documents.priorityOpen > 0))
  ) {
    return "urgent";
  }
  if (
    (trackingStatus === "bidding" || checklist.progressPct >= 80) &&
    documents.blocked === 0 &&
    documents.questions === 0 &&
    documents.progressPct >= 80
  ) {
    return "ready";
  }
  return "needs_work";
}

function resolveAudienceUrgency(daysUntilAudience: number | null): AudienceTrackingUrgency {
  if (daysUntilAudience == null) return "unknown";
  if (daysUntilAudience < 0) return "past";
  if (daysUntilAudience === 0) return "today";
  if (daysUntilAudience <= 7) return "week";
  if (daysUntilAudience <= 30) return "month";
  return "later";
}

function resolveActionStatus(dueAt: string | null, now: Date): AudienceTrackingActionStatus {
  if (!dueAt) return "none";
  const dueTime = Date.parse(dueAt);
  if (!Number.isFinite(dueTime)) return "none";
  if (dueTime < now.getTime()) return "overdue";
  const dayMs = 24 * 60 * 60 * 1000;
  return dueTime - now.getTime() <= 7 * dayMs ? "due_soon" : "scheduled";
}

function readinessLabel(readiness: AudienceTrackingReadiness): string {
  const labels: Record<AudienceTrackingReadiness, string> = {
    ready: "Prêt à arbitrer",
    needs_work: "Préparation à compléter",
    urgent: "Action urgente",
    blocked: "Document bloquant",
    missing_date: "Audience à dater",
    past: "Audience passée",
    closed: "Dossier clos",
    archived: "Archivé",
  };
  return labels[readiness];
}

function priorityScore({
  readiness,
  actionStatus,
  daysUntilAudience,
  checklist,
  documents,
}: {
  readiness: AudienceTrackingReadiness;
  actionStatus: AudienceTrackingActionStatus;
  daysUntilAudience: number | null;
  checklist: AudienceTrackingChecklistMetrics;
  documents: AudienceTrackingDocumentMetrics;
}): number {
  let score = 0;
  if (readiness === "blocked") score += 1_000;
  if (readiness === "urgent") score += 900;
  if (actionStatus === "overdue") score += 300;
  if (actionStatus === "due_soon") score += 150;
  if (documents.priorityOpen > 0) score += documents.priorityOpen * 50;
  if (documents.questions > 0) score += documents.questions * 40;
  if (checklist.open > 0) score += Math.min(120, checklist.open * 12);
  if (daysUntilAudience == null) score += 80;
  if (daysUntilAudience != null && daysUntilAudience >= 0) {
    score += Math.max(0, 60 - daysUntilAudience);
  }
  return score;
}

function countSaleDocuments(sale: AuctionSale): number {
  if (Array.isArray(sale.documents_rich) && sale.documents_rich.length) {
    return sale.documents_rich.length;
  }
  if (Array.isArray(sale.documents)) return sale.documents.filter(Boolean).length;
  if (sale.documents && typeof sale.documents === "object") {
    return Object.keys(sale.documents as Record<string, unknown>).length;
  }
  if (typeof sale.documents === "string" && sale.documents.trim()) return 1;
  return 0;
}

function daysUntil(value: string | null, now: Date): number | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(now.getTime())) return null;
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.ceil((date.getTime() - now.getTime()) / dayMs);
}

function compareAudienceTrackingItems(
  left: AudienceTrackingItem,
  right: AudienceTrackingItem,
): number {
  return (
    right.priorityScore - left.priorityScore ||
    compareByAudienceDate(left, right) ||
    left.trackingStatusLabel.localeCompare(right.trackingStatusLabel)
  );
}

function compareByAudienceDate(left: AudienceTrackingItem, right: AudienceTrackingItem): number {
  const leftTime = left.saleDate ? Date.parse(left.saleDate) : Number.POSITIVE_INFINITY;
  const rightTime = right.saleDate ? Date.parse(right.saleDate) : Number.POSITIVE_INFINITY;
  return leftTime - rightTime;
}

function isPriorityItem(item: AudienceTrackingItem): boolean {
  return (
    item.readiness === "blocked" ||
    item.readiness === "urgent" ||
    item.actionStatus === "overdue" ||
    item.actionStatus === "due_soon" ||
    item.documents.questions > 0 ||
    item.documents.priorityOpen > 0
  );
}

function isActiveTrackingStatus(status: SaleWorkspace["tracking_status"]): boolean {
  return status === "watching" || status === "reviewing" || status === "bidding";
}

function pct(done: number, total: number): number {
  if (!total) return 100;
  return Math.round((done / total) * 100);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

async function loadWorkspaceRows(
  auth: SupabaseAuthContext,
  includeArchived: boolean,
): Promise<SaleWorkspaceRow[]> {
  let query = auth.supabase
    .from("sale_workspaces")
    .select("*")
    .eq("user_id", auth.userId)
    .order("next_action_due_at", { ascending: true, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .limit(AUDIENCE_TRACKING_WORKSPACE_LIMIT);

  if (!includeArchived) query = query.neq("tracking_status", "archived");

  const { data, error } = await query;
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
