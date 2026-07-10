import { z } from "zod";
import type { User } from "@supabase/supabase-js";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { hasAdminRole, normalizeEmail } from "@/lib/account";
import { normalizePlanCode, type PlanCode, type PlanStatus } from "@/lib/plans";

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

export const adminSubscriptionGrantInputSchema = z.object({
  target: z.string().trim().min(3).max(320),
  planCode: z.enum(["decouverte", "analyse"]).default("analyse"),
  status: planStatusSchema.default("active"),
  currentPeriodEnd: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? new Date(value).toISOString() : null)),
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
): Promise<AdminSubscriptionListResponse> {
  await assertAdminAuth(authToken);

  const { data, error } = await supabaseAdmin
    .from("user_subscriptions")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) throw error;

  const emailByUserId = await getEmailsByUserId((data ?? []).map((row) => row.user_id));
  return {
    subscriptions: (data ?? []).map((row) =>
      subscriptionToSummary(row, emailByUserId.get(row.user_id) ?? null),
    ),
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

  const { data, error } = await supabaseAdmin
    .from("user_subscriptions")
    .upsert(payload, { onConflict: "user_id" })
    .select("*")
    .single();

  if (error) throw error;

  return {
    subscription: subscriptionToSummary(data, user.email ?? null),
    resolvedUser: {
      id: user.id,
      email: user.email ?? null,
    },
  };
}

export function manualSubscriptionPayload({
  input,
  user,
  existing,
  grantedBy,
}: {
  input: AdminSubscriptionGrantPayload;
  user: Pick<User, "id" | "email">;
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
    metadata: asJson({
      ...jsonObject(existing?.metadata),
      manual_grant: {
        source: "admin",
        granted_by: grantedBy,
        granted_at: new Date().toISOString(),
        target_email: user.email ?? null,
        plan_code: input.planCode,
        status: input.status,
        note: input.note,
      },
    }),
  };
}

async function assertAdminAuth(authToken: string) {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!hasAdminRole(auth.claims)) {
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
  const uniqueIds = Array.from(new Set(userIds)).slice(0, 50);
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
    status: subscription.status,
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
