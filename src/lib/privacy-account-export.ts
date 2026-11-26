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
 * Règle des colonnes (art. 15.4 RGPD : la copie ne porte pas atteinte aux droits des tiers) :
 * - `EXCLUDED_KEY`, partout (colonnes et clés des JSON, à toute profondeur) : secrets, jetons, empreintes,
 *   clés d'idempotence, identifiants bruts de Stripe, de Resend et des autres fournisseurs, acteurs
 *   d'administration ;
 * - `ACCOUNT_EXPORT_RULES`, par table (déclaration obligatoire pour chaque table de `ERASURE_TABLES`,
 *   vérifiée par `privacy-account-export.test.ts`) : notes et colonnes internes retirées, personnes
 *   masquées (identifiant ou adresse qui ne désigne pas le titulaire), contenu écrit par un tiers masqué ;
 * - `PERSON_JSON_KEY`, dans les JSON : adresse, nom ou identité d'une personne, masqués sauf s'ils
 *   désignent le titulaire.
 */

const PAGE_SIZE = 1000;
/** Au-delà, la table est marquée `truncated` : l'administrateur complète à la main. */
const MAX_ROWS_PER_TABLE = 10_000;

/** Valeur qui remplace une donnée de tiers. */
export const THIRD_PARTY_MASK = "tiers (masqué)";

const EXCLUDED_KEY =
  /(token|secret|password|hash|sha256|signature|idempotency|api_key|^stripe_|payment_intent|checkout_session|resend_email_id|deduction_reserved|provider|message_id|event_id|dedupe|fingerprint|^autopilot_|approved_by|reviewed_by|admin_notes)/i;

const PERSON_JSON_KEY =
  /((^|_)email$|^sender_|^recipient_|reply_to|address_origin|lawyer_id$|^owner_id$|^invited_by$|^collaborator_user_id$)/i;

type Row = Record<string, unknown>;
type TableExport = { rows: Row[]; truncated: boolean };

export type ExportRule = {
  /** Colonnes retirées : notes et acteurs d'administration, colonnes techniques internes. */
  drop?: readonly string[];
  /** Identifiant ou adresse d'une personne : masqué sauf s'il désigne le titulaire. */
  people?: readonly string[];
  /** Contenu écrit par un tiers : masqué sur les lignes que `when` désigne. */
  thirdPartyContent?: { columns: readonly string[]; when: (row: Row) => boolean };
};

/** Message qui n'est pas parti au nom du titulaire : réponse d'un professionnel, note interne. */
function notSentForAccount(row: Row): boolean {
  return row.direction !== "outbound" || row.message_kind === "manual_note";
}

/**
 * Règle d'export de chaque table de `ERASURE_TABLES`. `{}` déclare une table sans colonne de tiers ni
 * colonne interne au-delà de `EXCLUDED_KEY`. Les choix marqués « à trancher » sont masqués par défaut.
 */
export const ACCOUNT_EXPORT_RULES: Readonly<Record<string, ExportRule>> = {
  user_alerts: {},
  user_alert_matches: {},
  user_alert_notifications: {},
  user_favorites: {},
  // `lawyer_name` : avocat de la vente, donnée publique de l'annonce consultée.
  user_followed_sale_snapshots: {},
  user_investor_profiles: {},
  account_product_events: {},
  sale_signal_feedback: {},
  sale_reminder_dispatches: {},
  weekly_digest_dispatches: {},
  sale_result_dispatches: {},
  launch_offer_end_notices: {},
  launch_offer_end_notice_optouts: {},
  onboarding_email_notices: {},
  onboarding_email_optouts: {},
  user_watched_zones: {},
  user_sale_change_events: {},
  user_sale_unlocks: {},
  sale_unlock_purchases: {},
  user_sale_watch_snapshots: {},
  user_sale_analysis_items: {},
  user_sale_analysis_sets: {},
  saved_property_reports: {},
  property_report_exports: {},
  sale_data_exports: {},
  sale_workspace_annotations: {},
  // Lue par le propriétaire, l'auteur de l'invitation, l'invité et l'adresse : chaque personne qui
  // n'est pas le titulaire est masquée (collaborateurs qu'il a invités, propriétaire qui l'a invité).
  sale_workspace_collaborators: {
    people: ["owner_id", "invited_by", "collaborator_user_id", "invited_email"],
  },
  sale_workspaces: {},
  // `requested_lawyer_id` (et `metadata.selected_lawyer_id`) : avocat destinataire, à trancher.
  lawyer_referral_requests: { drop: ["admin_notes"], people: ["requested_lawyer_id"] },
  listing_publication_requests: { drop: ["admin_notes", "reviewed_by"] },
  data_refresh_requests: {},
  feature_usage_events: {},
  user_api_keys: {},
  user_notification_preferences: {},
  offer_opening_notifications: {},
  // L'adresse de la plateforme (`from_address`) n'est pas une personne ; `to_address` l'est.
  email_send_log: { people: ["to_address"] },
  // Le titulaire garde ses demandes envoyées (objet, texte) ; la réponse d'un professionnel (objet,
  // texte, pièces) et son adresse sont masquées.
  information_agent_messages: {
    people: ["from_email", "to_email"],
    thirdPartyContent: {
      columns: ["subject", "body_text", "attachments"],
      when: notSentForAccount,
    },
  },
  // Le destinataire (professionnel) est masqué ; l'adresse de réponse est une adresse de routage interne.
  // Le texte de la demande, écrit pour le titulaire, reste.
  information_agent_missions: {
    drop: ["reply_to_email"],
    people: ["recipient_email", "recipient_name", "recipient_identity_keys"],
  },
  information_agent_case_subscribers: {},
  stripe_checkout_access_grants: {},
  stripe_payment_lifecycle: {},
  user_subscriptions: {},
  user_profiles: {},
};

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

/** Le titulaire : son identifiant de compte ou son adresse (normalisée). */
type Account = { id: string; email: string };

function isAccount(value: unknown, account: Account): boolean {
  if (typeof value !== "string") return false;
  return value === account.id || (account.email !== "" && normalizeEmail(value) === account.email);
}

function maskPerson(value: unknown, account: Account): unknown {
  return value == null || isAccount(value, account) ? value : THIRD_PARTY_MASK;
}

/** Retire les clés internes et masque les personnes, à toute profondeur d'un JSON. */
function cleanJson(value: unknown, account: Account): unknown {
  if (Array.isArray(value)) return value.map((item) => cleanJson(item, account));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Row).flatMap(([key, item]) => {
      if (EXCLUDED_KEY.test(key)) return [];
      if (PERSON_JSON_KEY.test(key)) return [[key, maskPerson(item, account)]];
      return [[key, cleanJson(item, account)]];
    }),
  );
}

/** Applique la règle de la table à une ligne lue par `select("*")`. */
export function exportRow(row: Row, rule: ExportRule, account: Account): Row {
  const drop = new Set(rule.drop ?? []);
  const people = new Set(rule.people ?? []);
  const thirdParty = rule.thirdPartyContent?.when(row)
    ? new Set(rule.thirdPartyContent.columns)
    : new Set<string>();
  return Object.fromEntries(
    Object.entries(row).flatMap(([key, value]) => {
      if (EXCLUDED_KEY.test(key) || drop.has(key)) return [];
      if (thirdParty.has(key)) return [[key, value == null ? value : THIRD_PARTY_MASK]];
      if (people.has(key)) {
        return [
          [
            key,
            Array.isArray(value) && value.length ? THIRD_PARTY_MASK : maskPerson(value, account),
          ],
        ];
      }
      return [[key, cleanJson(value, account)]];
    }),
  );
}

function ruleFor(table: string): ExportRule {
  const rule = ACCOUNT_EXPORT_RULES[table];
  // Une table sans règle déclarée n'est jamais exportée « telle quelle ».
  if (!rule) throw new Error(`Account export has no rule for ${table}.`);
  return rule;
}

type PageQuery = (
  from: number,
  to: number,
) => PromiseLike<{ data: Row[] | null; error: { message?: string } | null }>;

async function readAll(
  table: string,
  account: Account,
  page: PageQuery,
  keep: (row: Row) => boolean = () => true,
): Promise<TableExport> {
  const rule = ruleFor(table);
  const rows: Row[] = [];
  for (let from = 0; from < MAX_ROWS_PER_TABLE; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Account export failed in ${table}: ${error.message ?? "unknown"}`);
    rows.push(...(data ?? []).filter(keep).map((row) => exportRow(row, rule, account)));
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
  const account: Account = { id: userId, email };
  const client = supabaseAdmin as unknown as SelectBuilder;

  const tables: Record<string, TableExport> = {};
  for (const [table, column] of ERASURE_TABLES) {
    tables[`${table}.${column}`] = await readAll(table, account, (from, to) =>
      client.from(table).select("*").eq(column, userId).range(from, to),
    );
  }
  const empty: TableExport = { rows: [], truncated: false };
  const emailSendLog = email
    ? await readAll("email_send_log", account, (from, to) =>
        client.from("email_send_log").select("*").eq("to_address", email).range(from, to),
      )
    : empty;
  // `ilike` ne fait que réduire la lecture (PostgREST lit `*` comme `%`) : l'égalité exacte décide.
  const workspaceInvitations = email
    ? await readAll(
        "sale_workspace_collaborators",
        account,
        (from, to) =>
          client
            .from("sale_workspace_collaborators")
            .select("*")
            .ilike("invited_email", escapeLikePattern(email))
            .range(from, to),
        (row) => normalizeEmail(row.invited_email as string | null) === email,
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
