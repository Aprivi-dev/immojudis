import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  DEFAULT_DOCUMENT_REVIEW,
  DEFAULT_WORKSPACE_NOTES,
  DOCUMENT_REVIEW_STATUSES,
  SALE_WORKSPACE_STATUSES,
  type SaleWorkspaceChecklist,
  type SaleWorkspaceDocumentReview,
  type SaleWorkspaceDocumentReviews,
  type SaleWorkspacePrivateNotes,
  type SaleWorkspaceStatus,
} from "@/lib/sale-workspace-shared";

type SaleWorkspaceRow = Database["public"]["Tables"]["sale_workspaces"]["Row"];
type SaleWorkspaceInsert = Database["public"]["Tables"]["sale_workspaces"]["Insert"];

export const workspaceNotesSchema = z
  .object({
    general: z.string().max(5000).default(""),
    occupation: z.string().max(5000).default(""),
    works: z.string().max(5000).default(""),
    market: z.string().max(5000).default(""),
    privateMode: z.boolean().default(true),
  })
  .default(DEFAULT_WORKSPACE_NOTES);

export const documentReviewSchema = z
  .object({
    status: z.enum(DOCUMENT_REVIEW_STATUSES).default(DEFAULT_DOCUMENT_REVIEW.status),
    note: z.string().max(3000).default(DEFAULT_DOCUMENT_REVIEW.note),
    question: z.string().max(1500).default(DEFAULT_DOCUMENT_REVIEW.question),
    priority: z.boolean().default(DEFAULT_DOCUMENT_REVIEW.priority),
    reviewedAt: z.string().datetime().nullable().default(DEFAULT_DOCUMENT_REVIEW.reviewedAt),
    documentLabel: z.string().trim().max(300).nullable().default(null),
    documentType: z.string().trim().max(120).nullable().default(null),
    documentUrl: z.string().trim().max(2000).nullable().default(null),
    readPages: z
      .preprocess((value) => normalizeBooleanRecord(value as Json), z.record(z.boolean()))
      .default(DEFAULT_DOCUMENT_REVIEW.readPages),
    highlightedExcerpt: z.string().max(5000).nullable().default(null),
  })
  .default(DEFAULT_DOCUMENT_REVIEW);

export const documentReviewsSchema = z.record(documentReviewSchema).default({});

export const saleWorkspaceInputSchema = z.object({
  saleId: z.string().uuid(),
  trackingStatus: z.enum(SALE_WORKSPACE_STATUSES).optional(),
  userMaxBidEur: z.number().finite().min(0).nullable().optional(),
  targetYieldPct: z.number().finite().min(0).max(100).nullable().optional(),
  privateNotes: workspaceNotesSchema.optional(),
  checklist: z.record(z.boolean()).optional(),
  alertPreferences: z.record(z.boolean()).optional(),
  documentReviews: documentReviewsSchema.optional(),
  nextAction: z.string().trim().max(300).nullable().optional(),
  nextActionDueAt: z.string().datetime().nullable().optional(),
});

export type SaleWorkspaceInput = z.input<typeof saleWorkspaceInputSchema>;
export type SaleWorkspacePayload = z.output<typeof saleWorkspaceInputSchema>;

export type SaleWorkspace = Omit<
  SaleWorkspaceRow,
  "private_notes" | "checklist" | "alert_preferences" | "document_reviews" | "tracking_status"
> & {
  tracking_status: SaleWorkspaceStatus;
  private_notes: SaleWorkspacePrivateNotes;
  checklist: SaleWorkspaceChecklist;
  alert_preferences: SaleWorkspaceChecklist;
  document_reviews: SaleWorkspaceDocumentReviews;
};

export type SaleWorkspaceResponse = {
  workspace: SaleWorkspace | null;
};

export async function getSaleWorkspace({
  auth,
  saleId,
}: {
  auth: SupabaseAuthContext;
  saleId: string;
}): Promise<SaleWorkspaceResponse> {
  const { data, error } = await auth.supabase
    .from("sale_workspaces")
    .select("*")
    .eq("user_id", auth.userId)
    .eq("sale_id", saleId)
    .maybeSingle();

  if (error) throw error;
  return { workspace: data ? normalizeWorkspace(data) : null };
}

export async function upsertSaleWorkspace({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: SaleWorkspacePayload;
}): Promise<SaleWorkspaceResponse> {
  const insertPayload: SaleWorkspaceInsert = {
    user_id: auth.userId,
    sale_id: input.saleId,
    tracking_status: hasInput(input, "trackingStatus") ? input.trackingStatus : undefined,
    user_max_bid_eur: hasInput(input, "userMaxBidEur") ? (input.userMaxBidEur ?? null) : undefined,
    target_yield_pct: hasInput(input, "targetYieldPct")
      ? (input.targetYieldPct ?? null)
      : undefined,
    private_notes: input.privateNotes ? asJson(input.privateNotes) : undefined,
    checklist: input.checklist ? asJson(input.checklist) : undefined,
    alert_preferences: input.alertPreferences ? asJson(input.alertPreferences) : undefined,
    document_reviews: input.documentReviews ? asJson(input.documentReviews) : undefined,
    next_action: hasInput(input, "nextAction") ? (input.nextAction ?? null) : undefined,
    next_action_due_at: hasInput(input, "nextActionDueAt")
      ? (input.nextActionDueAt ?? null)
      : undefined,
    last_synced_at: new Date().toISOString(),
  };

  const { data, error } = await auth.supabase
    .from("sale_workspaces")
    .upsert(insertPayload, { onConflict: "user_id,sale_id" })
    .select("*")
    .single();

  if (error) throw error;
  return { workspace: normalizeWorkspace(data) };
}

export function normalizeWorkspace(row: SaleWorkspaceRow): SaleWorkspace {
  return {
    ...row,
    tracking_status: normalizeStatus(row.tracking_status),
    private_notes: normalizeNotes(row.private_notes),
    checklist: normalizeBooleanRecord(row.checklist),
    alert_preferences: normalizeBooleanRecord(row.alert_preferences),
    document_reviews: normalizeDocumentReviews(row.document_reviews),
  };
}

export function normalizeNotes(value: Json): SaleWorkspacePrivateNotes {
  const parsed = workspaceNotesSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return DEFAULT_WORKSPACE_NOTES;
}

export function normalizeBooleanRecord(value: Json): SaleWorkspaceChecklist {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
      .map(([key, selected]) => [key, selected]),
  );
}

export function normalizeDocumentReviews(value: Json): SaleWorkspaceDocumentReviews {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, review]) => {
      const trimmedKey = key.trim();
      if (!trimmedKey || trimmedKey.length > 240) return [];
      const parsed = documentReviewSchema.safeParse(review);
      return parsed.success ? [[trimmedKey, parsed.data]] : [];
    }),
  );
}

function normalizeStatus(value: string): SaleWorkspaceStatus {
  return SALE_WORKSPACE_STATUSES.includes(value as SaleWorkspaceStatus)
    ? (value as SaleWorkspaceStatus)
    : "watching";
}

function asJson(value: unknown): Json {
  return value as Json;
}

function hasInput<K extends keyof SaleWorkspacePayload>(
  input: SaleWorkspacePayload,
  key: K,
): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}
