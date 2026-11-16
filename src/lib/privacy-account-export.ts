import "server-only";
import { assertAdmin } from "@/lib/admin-auth.server";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizeEmail } from "@/lib/account";
import { PublicApiError } from "@/lib/api-errors";
import { escapeLikePattern } from "@/lib/information-agent-professional-rights";
import { privacyRequestSubjectKind } from "@/lib/privacy-request-types";
import { ERASURE_TABLES } from "@/lib/privacy-requests";

/**
 * Copie des données d'un titulaire de compte (demande d'accès ou de portabilité), remise par
 * l'administrateur à l'adresse du demandeur.
 *
 * Elle parcourt la MÊME liste que l'effacement (`ERASURE_TABLES`, seule source : une table ajoutée à
 * l'effacement entre dans l'export, `privacy-account-export.test.ts` le vérifie), plus le compte
 * lui-même, ses demandes de droits et ce que l'effacement retrouve par l'adresse (journal des emails,
 * invitations reçues sans compte).
 *
 * Règle des colonnes, celle de l'export d'un professionnel : rien qui serve à agir à la place de la
 * personne ni d'identifiant technique interne. `EXCLUDED_COLUMN` retire les secrets, jetons, empreintes,
 * clés d'idempotence et identifiants bruts de Stripe et de Resend.
 */

const PAGE_SIZE = 1000;
/** Au-delà, la table est marquée `truncated` : l'administrateur complète à la main. */
const MAX_ROWS_PER_TABLE = 10_000;

const EXCLUDED_COLUMN =
  /(token|secret|password|hash|signature|idempotency|api_key|^stripe_|payment_intent|checkout_session|resend_email_id|deduction_reserved|provider_message_id)/i;

type Row = Record<string, unknown>;
type TableExport = { rows: Row[]; truncated: boolean };

export type AccountDataExport = {
  generatedAt: string;
  account: {
    id: string;
    email: string | null;
    createdAt: string | null;
    emailConfirmedAt: string | null;
    lastSignInAt: string | null;
  };
  /** Une entrée par élément de `ERASURE_TABLES`, clé `table.colonne`. */
  tables: Record<string, TableExport>;
  /** Retrouvé par l'adresse du compte, comme à l'effacement. */
  byAddress: {
    emailSendLog: TableExport;
    workspaceInvitations: TableExport;
  };
  privacyRequests: Row[];
};

function withoutInternalColumns(row: Row): Row {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !EXCLUDED_COLUMN.test(key)));
}

type PageQuery = (
  from: number,
  to: number,
) => PromiseLike<{ data: Row[] | null; error: { message?: string } | null }>;

async function readAll(table: string, page: PageQuery): Promise<TableExport> {
  const rows: Row[] = [];
  for (let from = 0; from < MAX_ROWS_PER_TABLE; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Account export failed in ${table}: ${error.message ?? "unknown"}`);
    rows.push(...(data ?? []).map(withoutInternalColumns));
    if ((data?.length ?? 0) < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

type SelectBuilder = {
  from(name: string): {
    select(columns: "*"): {
      eq(column: string, value: string): { range: PageQuery };
      ilike(column: string, pattern: string): { range: PageQuery };
    };
  };
};

export async function collectAccountData(userId: string): Promise<AccountDataExport> {
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (authError) throw authError;
  const user = authData.user;
  const email = normalizeEmail(user?.email);
  const client = supabaseAdmin as unknown as SelectBuilder;

  const tables: Record<string, TableExport> = {};
  for (const [table, column] of ERASURE_TABLES) {
    tables[`${table}.${column}`] = await readAll(table, (from, to) =>
      client.from(table).select("*").eq(column, userId).range(from, to),
    );
  }
  const empty: TableExport = { rows: [], truncated: false };
  const emailSendLog = email
    ? await readAll("email_send_log", (from, to) =>
        client.from("email_send_log").select("*").eq("to_address", email).range(from, to),
      )
    : empty;
  const workspaceInvitations = email
    ? await readAll("sale_workspace_collaborators", (from, to) =>
        client
          .from("sale_workspace_collaborators")
          .select("*")
          .ilike("invited_email", escapeLikePattern(email))
          .range(from, to),
      )
    : empty;

  const { data: requests, error: requestsError } = await supabaseAdmin
    .from("data_subject_requests")
    .select("id,request_type,status,message,submitted_at,acknowledged_at,due_at,completed_at")
    .eq("user_id", userId)
    .order("submitted_at", { ascending: true });
  if (requestsError) throw requestsError;

  return {
    generatedAt: new Date().toISOString(),
    account: {
      id: userId,
      email: user?.email ?? null,
      createdAt: user?.created_at ?? null,
      emailConfirmedAt: user?.email_confirmed_at ?? null,
      lastSignInAt: user?.last_sign_in_at ?? null,
    },
    tables,
    byAddress: { emailSendLog, workspaceInvitations },
    privacyRequests: requests ?? [],
  };
}

/** Export d'un compte pour sa demande d'accès ou de portabilité (administrateur seulement). */
export async function exportAccountPrivacyData({
  auth,
  requestId,
}: {
  auth: SupabaseAuthContext;
  requestId: string;
}): Promise<AccountDataExport> {
  assertAdmin(auth);
  const { data: request, error } = await supabaseAdmin
    .from("data_subject_requests")
    .select("id,request_type,identity_status,user_id,metadata")
    .eq("id", requestId)
    .single();
  if (error) throw error;
  if (
    !request.user_id ||
    privacyRequestSubjectKind(request) !== "account" ||
    !["access", "portability"].includes(request.request_type)
  ) {
    throw new PublicApiError(
      "Cette demande n'est pas une demande d'accès d'un titulaire de compte.",
      409,
    );
  }
  if (request.identity_status === "additional_verification_required") {
    throw new PublicApiError("Terminez la vérification d'identité avant d'exporter.", 409);
  }
  return collectAccountData(request.user_id);
}
