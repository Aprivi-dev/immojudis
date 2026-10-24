import { z } from "zod";
import { PublicApiError } from "@/lib/api-errors";
import { saveFavoriteDossier } from "@/lib/favorite-dossier";
import { pilotDraftSchema } from "@/lib/professional-pilots";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  DEFAULT_DOCUMENT_REVIEW,
  DEFAULT_WORKSPACE_NOTES,
  DOCUMENT_REVIEW_STATUSES,
  SALE_WORKSPACE_STATUSES,
  type SaleWorkspaceChecklist,
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
    // `pilotDraftSchema` est un schéma zod/mini (partagé avec le navigateur) : pas de `.optional()`.
    professionalDossier: z.optional(pilotDraftSchema),
  })
  // `prefault` reprend le `.default()` de zod 3 : la valeur par défaut repasse par le schéma et
  // donne un objet neuf à chaque lecture (le `.default()` de zod 4 la renverrait telle quelle).
  .prefault(DEFAULT_WORKSPACE_NOTES);

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
      .preprocess(
        (value) => normalizeBooleanRecord(value as Json),
        z.record(z.string(), z.boolean()),
      )
      .default(DEFAULT_DOCUMENT_REVIEW.readPages),
    highlightedExcerpt: z.string().max(5000).nullable().default(null),
  })
  .prefault(DEFAULT_DOCUMENT_REVIEW);

export const documentReviewsSchema = z.record(z.string(), documentReviewSchema).default({});

export const saleWorkspaceInputSchema = z.object({
  saleId: z.string().guid(),
  trackingStatus: z.enum(SALE_WORKSPACE_STATUSES).optional(),
  userMaxBidEur: z.number().finite().min(0).nullable().optional(),
  targetYieldPct: z.number().finite().min(0).max(100).nullable().optional(),
  // Zod 4 appliquerait la valeur par défaut sous `.optional()` : sans `unwrap()`, des notes ou des
  // revues omises écraseraient celles déjà enregistrées (voir `hasInput`).
  privateNotes: workspaceNotesSchema.unwrap().optional(),
  checklist: z.record(z.string(), z.boolean()).optional(),
  alertPreferences: z.record(z.string(), z.boolean()).optional(),
  documentReviews: documentReviewsSchema.unwrap().optional(),
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

export const professionalPilotSaveSchema = z.object({
  saleId: z.string().guid(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  draft: pilotDraftSchema,
});

export type ProfessionalPilotSaveInput = z.infer<typeof professionalPilotSaveSchema>;

export class SaleWorkspaceConflictError extends PublicApiError {
  constructor() {
    super("Le dossier a changé sur votre compte. Rechargez la page avant de l'enregistrer.", 409);
    this.name = "SaleWorkspaceConflictError";
  }
}

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
  // « Mon dossier » (`user_favorites.personal_status`) est la source unique du statut : le PUT
  // l'écrit d'abord là. La vente doit être suivie, sinon la réponse (404) le dit et rien n'est
  // écrit. `tracking_status` n'en est plus qu'une copie, gardée pour les lectures existantes
  // (suivi des audiences, suivi des changements) ; aucun écran ne s'appuie dessus.
  if (hasInput(input, "trackingStatus") && input.trackingStatus !== undefined) {
    await saveFavoriteDossier({
      auth,
      input: { saleId: input.saleId, personalStatus: input.trackingStatus },
    });
  }

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

/** Atomically compare the workspace revision before replacing its private notes. */
export async function saveProfessionalPilot({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: ProfessionalPilotSaveInput;
}): Promise<SaleWorkspaceResponse> {
  const { data: existing, error: readError } = await auth.supabase
    .from("sale_workspaces")
    .select("*")
    .eq("user_id", auth.userId)
    .eq("sale_id", input.saleId)
    .maybeSingle();
  if (readError) throw readError;
  if ((existing?.updated_at ?? null) !== input.expectedUpdatedAt) {
    throw new SaleWorkspaceConflictError();
  }

  if (existing) {
    if (!input.expectedUpdatedAt) throw new SaleWorkspaceConflictError();
    const notes = {
      ...normalizeNotes(existing.private_notes),
      professionalDossier: input.draft,
    };
    const { data, error } = await auth.supabase
      .from("sale_workspaces")
      .update({ private_notes: asJson(notes), last_synced_at: new Date().toISOString() })
      .eq("user_id", auth.userId)
      .eq("sale_id", input.saleId)
      .eq("updated_at", input.expectedUpdatedAt)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new SaleWorkspaceConflictError();
    return { workspace: normalizeWorkspace(data) };
  }

  const { data, error } = await auth.supabase
    .from("sale_workspaces")
    .insert({
      user_id: auth.userId,
      sale_id: input.saleId,
      private_notes: asJson({ ...DEFAULT_WORKSPACE_NOTES, professionalDossier: input.draft }),
    })
    .select("*")
    .single();
  if (error?.code === "23505") throw new SaleWorkspaceConflictError();
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
