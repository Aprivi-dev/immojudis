import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { featureIncluded } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";

type ApiKeyRow = Database["public"]["Tables"]["user_api_keys"]["Row"];

const API_KEY_SECRET_PREFIX = "ij_live_";
const API_KEY_PREFIX_LENGTH = 18;
const API_KEY_DEFAULT_SCOPES = ["sales.feed:read"] as const;

export const apiKeyCreateInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  expiresAt: z.string().datetime().nullable().optional(),
});

export type ApiKeyCreateInput = z.input<typeof apiKeyCreateInputSchema>;
export type ApiKeyCreatePayload = z.output<typeof apiKeyCreateInputSchema>;

export type ApiKeySummary = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

export type ApiKeyListResponse = {
  keys: ApiKeySummary[];
  limit: number | null;
};

export type ApiKeyCreateResponse = {
  key: ApiKeySummary;
  secret: string;
  limit: number | null;
};

export type ApiKeyAuthContext = SupabaseAuthContext & {
  claims: SupabaseAuthContext["claims"] & {
    api_key_id: string;
    api_key_scopes: string[];
  };
};

export async function listUserApiKeys({
  auth,
}: {
  auth: SupabaseAuthContext;
}): Promise<ApiKeyListResponse> {
  const plan = await resolvePlanEntitlements(auth);
  const { data, error } = await supabaseAdmin
    .from("user_api_keys")
    .select("*")
    .eq("user_id", auth.userId)
    .order("created_at", { ascending: false });

  if (error) throw error;

  return {
    keys: (data ?? []).map(apiKeyRowToSummary),
    limit: plan.limits.apiKeys,
  };
}

export async function createUserApiKey({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: ApiKeyCreatePayload;
}): Promise<ApiKeyCreateResponse> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "sales.apiAccess")) {
    throw new Error("Clés API réservées au plan Analyse ou Investisseur.");
  }

  await assertApiKeyLimit(auth, plan.limits.apiKeys);

  const secret = generateApiKeySecret();
  const { data, error } = await supabaseAdmin
    .from("user_api_keys")
    .insert({
      user_id: auth.userId,
      name: input.name,
      key_prefix: apiKeyLookupPrefix(secret),
      key_hash: hashApiKey(secret),
      scopes: [...API_KEY_DEFAULT_SCOPES],
      expires_at: input.expiresAt ?? null,
    })
    .select("*")
    .single();

  if (error) throw error;

  return {
    key: apiKeyRowToSummary(data),
    secret,
    limit: plan.limits.apiKeys,
  };
}

export async function revokeUserApiKey({
  auth,
  keyId,
}: {
  auth: SupabaseAuthContext;
  keyId: string;
}): Promise<{ key: ApiKeySummary }> {
  const revokedAt = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("user_api_keys")
    .update({
      revoked_at: revokedAt,
      updated_at: revokedAt,
    })
    .eq("id", keyId)
    .eq("user_id", auth.userId)
    .select("*")
    .single();

  if (error) throw error;
  return { key: apiKeyRowToSummary(data) };
}

export async function apiKeyAuthContextFromRequest(
  request: Request,
  requiredScope = "sales.feed:read",
): Promise<ApiKeyAuthContext | null> {
  const secret = apiKeySecretFromRequest(request);
  if (!secret) return null;

  const row = await verifyApiKeySecret({ secret, requiredScope });
  return {
    supabase: supabaseAdmin,
    userId: row.user_id,
    claims: {
      sub: row.user_id,
      api_key_id: row.id,
      api_key_scopes: row.scopes,
    },
  };
}

export async function verifyApiKeySecret({
  secret,
  requiredScope = "sales.feed:read",
  now = new Date(),
}: {
  secret: string;
  requiredScope?: string;
  now?: Date;
}): Promise<ApiKeyRow> {
  if (!isApiKeySecret(secret)) throw new Error("Unauthorized: Invalid API key");

  const expectedHash = hashApiKey(secret);
  const { data, error } = await supabaseAdmin
    .from("user_api_keys")
    .select("*")
    .eq("key_prefix", apiKeyLookupPrefix(secret))
    .is("revoked_at", null)
    .limit(5);

  if (error) throw error;

  const row = (data ?? []).find((candidate) =>
    safeCompareHexDigests(candidate.key_hash, expectedHash),
  );
  if (!row) throw new Error("Unauthorized: Invalid API key");
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) {
    throw new Error("Unauthorized: API key expired");
  }
  if (!row.scopes.includes(requiredScope)) {
    throw new Error("Unauthorized: API key scope missing");
  }

  await supabaseAdmin
    .from("user_api_keys")
    .update({ last_used_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("id", row.id);

  return row;
}

export function apiKeySecretFromRequest(request: Request): string | null {
  const headerSecret = request.headers.get("x-immojudis-api-key")?.trim();
  if (headerSecret) return headerSecret;

  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.replace("Bearer ", "").trim();
  return isApiKeySecret(token) ? token : null;
}

export function generateApiKeySecret(): string {
  return `${API_KEY_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isApiKeySecret(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(API_KEY_SECRET_PREFIX) && value.length > 32;
}

export function apiKeyLookupPrefix(secret: string): string {
  return secret.slice(0, API_KEY_PREFIX_LENGTH);
}

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function safeCompareHexDigests(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function apiKeyRowToSummary(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: row.scopes,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

async function assertApiKeyLimit(auth: SupabaseAuthContext, limit: number | null) {
  if (limit == null) return;

  const { count, error } = await supabaseAdmin
    .from("user_api_keys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", auth.userId)
    .is("revoked_at", null);

  if (error) throw error;
  if ((count ?? 0) >= limit) {
    throw new Error(`Limite de ${limit} clés API actives atteinte.`);
  }
}
