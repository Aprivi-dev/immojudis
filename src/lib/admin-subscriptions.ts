import "server-only";
import { z } from "zod";
import type { User } from "@supabase/supabase-js";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { normalizeEmail } from "@/lib/account";
import { normalizePlanCode, type PlanCode, type PlanStatus } from "@/lib/plans";
import { isMissingRpcError } from "@/lib/postgrest-errors";

type UserSubscriptionRow = Database["public"]["Tables"]["user_subscriptions"]["Row"];
type UserSubscriptionInsert = Database["public"]["Tables"]["user_subscriptions"]["Insert"];

const planStatusSchema = z.enum([
  "trialing",
  "active",
  "past_due",
  "paused",
  "cancelled",
  "expired",
]);

const optionalDateTimeSchema = z
  .string()
  .trim()
  .optional()
  .refine((value) => !value || Number.isFinite(new Date(value).getTime()), {
    message: "La fin de période doit être une date valide.",
  })
  .transform((value) => (value ? new Date(value).toISOString() : null));

export const adminSubscriptionGrantInputSchema = z.object({
  target: z.string().trim().min(3).max(320),
  planCode: z.enum(["decouverte", "analyse"]).default("analyse"),
  status: planStatusSchema.default("active"),
  currentPeriodEnd: optionalDateTimeSchema,
  note: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value) => (value ? value : null)),
});

export type AdminSubscriptionGrantInput = z.input<typeof adminSubscriptionGrantInputSchema>;
export type AdminSubscriptionGrantPayload = z.output<typeof adminSubscriptionGrantInputSchema>;

export type AdminSubscriptionSummary = {
  userId: string;
  email: string | null;
  planCode: PlanCode;
  status: PlanStatus;
  currentPeriodEnd: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  metadata: Json;
  createdAt: string;
  updatedAt: string;
};

export type AdminSubscriptionListResponse = {
  subscriptions: AdminSubscriptionSummary[];
  totalCount: number;
  activeCount: number;
  truncated: boolean;
  offset: number;
  limit: number;
  hasMore: boolean;
};

export type AdminSubscriptionGrantResponse = {
  subscription: AdminSubscriptionSummary;
  resolvedUser: {
    id: string;
    email: string | null;
  };
};

export async function listAdminSubscriptions(
  authToken: string,
  { offset = 0, limit = 50 }: { offset?: number; limit?: number } = {},
): Promise<AdminSubscriptionListResponse> {
  await assertAdminAuth(authToken);
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));

  const [{ data, error, count }, { count: activeCount, error: activeError }] = await Promise.all([
    supabaseAdmin
      .from("user_subscriptions")
      .select("*", { count: "exact" })
      .order("updated_at", { ascending: false })
      .range(safeOffset, safeOffset + safeLimit - 1),
    supabaseAdmin
      .from("user_subscriptions")
      .select("user_id", { count: "exact", head: true })
      .eq("plan_code", "analyse")
      .in("status", ["active", "trialing"]),
  ]);

  if (error) throw error;
  if (activeError) throw activeError;

  const emailByUserId = await getEmailsByUserId((data ?? []).map((row) => row.user_id));
  const totalCount = count ?? data?.length ?? 0;
  return {
    subscriptions: (data ?? []).map((row) =>
      subscriptionToSummary(row, emailByUserId.get(row.user_id) ?? null),
    ),
    totalCount,
    activeCount: activeCount ?? 0,
    truncated: totalCount > (data?.length ?? 0),
    offset: safeOffset,
    limit: safeLimit,
    hasMore: safeOffset + (data?.length ?? 0) < totalCount,
  };
}

export async function grantAdminSubscription({
  authToken,
  input,
}: {
  authToken: string;
  input: AdminSubscriptionGrantPayload;
}): Promise<AdminSubscriptionGrantResponse> {
  const auth = await assertAdminAuth(authToken);
  const user = await findAuthUser(input.target);
  const existing = await getSubscriptionByUserId(user.id);
  const payload = manualSubscriptionPayload({
    input,
    user,
    existing,
    grantedBy: auth.userId,
  });

  const row = input.note
    ? await grantWithNote({ payload, userId: user.id, grantedBy: auth.userId, input })
    : await upsertGrant(payload);

  return {
    subscription: subscriptionToSummary(row, user.email ?? null),
    resolvedUser: {
      id: user.id,
      email: user.email ?? null,
    },
  };
}

/** Nombre d'attributions antérieures gardées dans `metadata.manual_grant_history`. */
export const MANUAL_GRANT_HISTORY_MAX = 10;

/**
 * Ajoute une attribution manuelle aux métadonnées d'un abonnement SANS écraser les précédentes : la
 * précédente `manual_grant` passe en tête de `manual_grant_history` (10 entrées au plus, les plus
 * récentes d'abord). L'historique ne garde ni note ni adresse email : la ligne est lisible par son
 * titulaire.
 */
export function withManualGrant(
  metadata: Json | null | undefined,
  grant: Record<string, unknown>,
): Record<string, unknown> {
  const base = jsonObject(metadata);
  const previous = base.manual_grant;
  const history = Array.isArray(base.manual_grant_history) ? base.manual_grant_history : [];
  const entries = [...(isRecord(previous) ? [previous] : []), ...history]
    .filter(isRecord)
    .map(({ note: _note, target_email: _targetEmail, ...entry }) => entry);
  return {
    ...base,
    manual_grant: grant,
    manual_grant_history: entries.slice(0, MANUAL_GRANT_HISTORY_MAX),
  };
}

export function manualSubscriptionPayload({
  input,
  user,
  existing,
  grantedBy,
}: {
  input: AdminSubscriptionGrantPayload;
  user: Pick<User, "id">;
  existing?: Pick<
    UserSubscriptionRow,
    "metadata" | "stripe_customer_id" | "stripe_subscription_id"
  > | null;
  grantedBy: string;
}): UserSubscriptionInsert {
  return {
    user_id: user.id,
    plan_code: input.planCode,
    status: input.status,
    current_period_end: input.currentPeriodEnd,
    stripe_customer_id: existing?.stripe_customer_id ?? null,
    stripe_subscription_id: existing?.stripe_subscription_id ?? null,
    // Pas d'adresse email recopiée ici : aucun lecteur, et elle deviendrait fausse si l'adresse change.
    metadata: asJson(
      withManualGrant(existing?.metadata, {
        source: "admin",
        granted_by: grantedBy,
        granted_at: new Date().toISOString(),
        plan_code: input.planCode,
        status: input.status,
        current_period_end: input.currentPeriodEnd,
        // Pas de motif ici : la ligne est lisible par son titulaire (il va dans app_private.manual_grant_notes).
      }),
    ),
  };
}

async function upsertGrant(payload: UserSubscriptionInsert): Promise<UserSubscriptionRow> {
  const { data, error } = await supabaseAdmin
    .from("user_subscriptions")
    .upsert(payload, { onConflict: "user_id" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/**
 * Attribution avec motif : la ligne et le motif (`app_private.manual_grant_notes`, jamais lisible par le
 * compte) s'écrivent dans la même transaction (`grant_manual_subscription`). Sans la fonction (migration
 * 20261108190000 pas encore appliquée), l'attribution est refusée : le motif ne retourne jamais dans la ligne.
 */
async function grantWithNote({
  payload,
  userId,
  grantedBy,
  input,
}: {
  payload: UserSubscriptionInsert;
  userId: string;
  grantedBy: string;
  input: AdminSubscriptionGrantPayload;
}): Promise<UserSubscriptionRow> {
  const { error } = await supabaseAdmin.rpc("grant_manual_subscription", {
    p_user_id: userId,
    p_granted_by: grantedBy,
    p_plan_code: input.planCode,
    p_status: input.status,
    p_current_period_end: input.currentPeriodEnd,
    p_metadata: payload.metadata ?? {},
    p_note: input.note ?? undefined,
  });
  if (error) {
    if (isMissingRpcError(error)) {
      throw new Error(
        "Le motif ne peut pas encore être enregistré (migration en attente) : attribution non faite. Réessayez sans motif ou après la migration.",
      );
    }
    throw error;
  }
  const row = await getSubscriptionByUserId(userId);
  if (!row) throw new Error("Abonnement introuvable après l'attribution.");
  return row;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function assertAdminAuth(authToken: string) {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) {
    throw new Error("Forbidden: ce compte n'a pas les droits administrateur Immojudis.");
  }
  return auth;
}

async function getSubscriptionByUserId(userId: string): Promise<UserSubscriptionRow | null> {
  const { data, error } = await supabaseAdmin
    .from("user_subscriptions")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function findAuthUser(target: string): Promise<User> {
  const normalizedTarget = target.trim();
  if (isUuid(normalizedTarget)) {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(normalizedTarget);
    if (error || !data.user) throw new Error("Utilisateur introuvable.");
    return data.user;
  }

  const targetEmail = normalizeEmail(normalizedTarget);
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const match = data.users.find((user) => normalizeEmail(user.email) === targetEmail);
    if (match) return match;
    if (data.users.length < 1000) break;
  }

  throw new Error("Utilisateur introuvable pour cet email.");
}

async function getEmailsByUserId(userIds: string[]): Promise<Map<string, string | null>> {
  const uniqueIds = Array.from(new Set(userIds));
  const entries = await Promise.all(
    uniqueIds.map(async (userId) => {
      const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
      return [userId, data.user?.email ?? null] as const;
    }),
  );
  return new Map(entries);
}

function subscriptionToSummary(
  subscription: UserSubscriptionRow,
  email: string | null,
): AdminSubscriptionSummary {
  return {
    userId: subscription.user_id,
    email,
    planCode: normalizePlanCode(subscription.plan_code),
    status: subscription.status as PlanStatus,
    currentPeriodEnd: subscription.current_period_end,
    stripeCustomerId: subscription.stripe_customer_id,
    stripeSubscriptionId: subscription.stripe_subscription_id,
    metadata: subscription.metadata,
    createdAt: subscription.created_at,
    updatedAt: subscription.updated_at,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function jsonObject(value: Json | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
