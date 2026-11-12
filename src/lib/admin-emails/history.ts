import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { AUTH_EMAIL_TEMPLATES, type AuthEmailTemplateId } from "@/lib/auth-email-templates";
import { recordEmailDeliveryEvent } from "@/lib/email-delivery-log";
import { deliveryStateOfLog, EMAIL_DELIVERY_LABELS } from "@/lib/email-delivery-status";
import { EMAIL_TEMPLATES } from "@/lib/email-templates/registry";
import { readResendApiKey } from "./env";
import { maskActionLinks, toInertEmailDocument } from "./link-masking";
import { fetchResendEmail, type ResendFailure } from "./resend";

/**
 * Onglet « Historique » du module Emails : emails envoyés (journal `email_send_log`) et reçus (réponses de
 * l'agent d'information, messages sans dossier ouvert).
 *
 * - Listes paginées par curseur `(created_at, id)`, 50 lignes, sans compteur total. Recherche exacte ou par
 *   préfixe sur l'adresse en minuscules.
 * - Tout est composé ici (libellés, couleurs, dates) : le navigateur n'affiche que du texte prêt à l'emploi.
 * - Le contenu d'un email envoyé se lit à la demande chez Resend (30 jours), masqué de ses liens d'action
 *   (`link-masking.ts`) ; celui d'un email reçu n'est JAMAIS du HTML : du texte, sans lien cliquable, et pour
 *   les pièces jointes un nom et une taille.
 * - Chaque consultation est tracée (`admin_email_access_log`, 6 mois) sans l'adresse ni le contenu. Si la
 *   trace ne peut pas être écrite, rien n'est affiché.
 */
export const HISTORY_PAGE_SIZE = 50;
/** Lignes dont le statut est relu chez Resend par « Actualiser », et âge maximal de ces lignes. */
const REFRESH_MAX_ROWS = 20;
const REFRESH_MAX_AGE_MS = 72 * 3_600_000;
const REFRESH_DEADLINE_MS = 18_000;

export type HistoryBox = "sent" | "received";
type HistoryRow = {
  /** `log:` (envoyé), `case:` (réponse à l'agent) ou `unrouted:` (sans dossier ouvert), puis l'identifiant. */
  id: string;
  at: string;
  who: string;
  subject: string;
  tag: string;
  /** `detail` : précision courte affichée à côté de l'état (rebond passager). */
  status?: { text: string; tone: "ok" | "bad" | "warn" | "neutral"; detail?: string };
};
export type HistoryList = { rows: HistoryRow[]; next: string | null; note?: string };
export type HistoryMessage = {
  title: string;
  lines: string[];
  /** `html` : document pour `<iframe sandbox="" srcdoc>` ; `text` : texte brut ; `note` : rien à montrer. */
  kind: "html" | "text" | "note";
  body: string;
  attachments: string[];
};

const dateFormat = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Europe/Paris",
});
const formatDate = (iso: string) => dateFormat.format(new Date(iso));

const SENT_STATUS: NonNullable<HistoryRow["status"]> = { text: "Envoyé", tone: "neutral" };

/**
 * État d'une ligne du journal. Un rebond dont `bounce_type` vaut « transient » (casse indifférente) est un
 * « Rebond passager », orange ; un rebond définitif ou de type inconnu reste un « Rebond » rouge.
 */
function sentStatus(row: { status: string; bounce_type: string | null }) {
  const state = deliveryStateOfLog(row.status, row.bounce_type);
  return state ? EMAIL_DELIVERY_LABELS[state] : SENT_STATUS;
}

const FAILURES: Record<ResendFailure | "expired", string> = {
  not_configured: "RESEND_API_KEY n’est pas renseignée : Resend n’a pas été interrogé.",
  missing_permission: "La clé Resend n’a pas le droit de lire les emails envoyés.",
  invalid_key: "Resend refuse la clé API.",
  rate_limited: "Resend limite le débit : réessayez dans un instant.",
  unavailable: "Resend est indisponible : réessayez dans un instant.",
  expired: "Contenu expiré chez Resend (conservé 30 jours).",
};

const templateLabel = (key: string) =>
  EMAIL_TEMPLATES.find((template) => template.key === key)?.label ?? key;

/** Libellés des emails de compte envoyés par Supabase Auth (SMTP de Resend), par gabarit. */
const AUTH_EMAIL_LABELS: Record<AuthEmailTemplateId, string> = {
  confirmation: "Confirmation d’inscription",
  recovery: "Réinitialisation du mot de passe",
  email_change: "Changement d’adresse email",
  invite: "Invitation",
  magic_link: "Lien de connexion",
  reauthentication: "Code de confirmation",
};

/**
 * Email de compte de Supabase Auth : il arrive au journal par le webhook seulement, donc en `unknown`.
 * Reconnu à l'affichage par l'objet exact d'un gabarit d'authentification ; sinon `null`. La
 * reconnaissance repose sur l'objet seul : si l'objet est modifié dans Supabase sans l'être dans
 * `auth-email-templates.ts`, la ligne retombe sur « unknown ».
 */
function authEmailLabel(row: { template_key: string; subject: string }): string | null {
  if (row.template_key !== "unknown") return null;
  const definition = AUTH_EMAIL_TEMPLATES.find((template) => template.subject === row.subject);
  return definition ? `Compte · ${AUTH_EMAIL_LABELS[definition.id]}` : null;
}

const rowLabel = (row: { template_key: string; subject: string }) =>
  authEmailLabel(row) ?? templateLabel(row.template_key);

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2}))\|([0-9a-f-]{36})$/i;

export class EmailHistoryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailHistoryInputError";
  }
}

function parseCursor(raw: string | null): { at: string; id: string } | null {
  if (!raw) return null;
  const match = CURSOR_PATTERN.exec(raw);
  if (!match || !ID_PATTERN.test(match[2]) || Number.isNaN(Date.parse(match[1]))) {
    throw new EmailHistoryInputError("Curseur invalide.");
  }
  return { at: match[1], id: match[2] };
}

/** Adresse cherchée : minuscules, sans espace, 3 à 200 caractères ; `null` si absente. */
function parseAddress(raw: string | null): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value.length < 3 || value.length > 200 || /[\s"'<>(),;*]/.test(value)) {
    throw new EmailHistoryInputError("Adresse de recherche invalide.");
  }
  return value;
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);
const cursorOf = (row: { created_at: string; id: string }) => `${row.created_at}|${row.id}`;

/** Trace de consultation : l'administrateur, la portée, un identifiant technique ou un nombre de lignes. */
async function traceAccess(
  adminUserId: string,
  scope: "admin.email.list" | "admin.email.view",
  detail: { targetId?: string; rows?: number },
): Promise<void> {
  const { error } = await supabaseAdmin.from("admin_email_access_log").insert({
    admin_user_id: adminUserId,
    scope,
    target_id: detail.targetId ?? null,
    row_count: detail.rows ?? null,
  });
  if (error) throw new Error("Trace de consultation impossible : consultation refusée.");
}

type SentRow = {
  id: string;
  created_at: string;
  template_key: string;
  to_address: string;
  subject: string;
  status: string;
  bounce_type: string | null;
  resend_email_id: string | null;
};

async function readSent(cursor: { at: string; id: string } | null, address: string | null) {
  let query = supabaseAdmin
    .from("email_send_log")
    .select("id,created_at,template_key,to_address,subject,status,bounce_type,resend_email_id")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(HISTORY_PAGE_SIZE + 1);
  if (address) query = query.like("to_address", `${escapeLike(address)}%`);
  if (cursor) {
    query = query.or(
      `created_at.lt."${cursor.at}",and(created_at.eq."${cursor.at}",id.lt.${cursor.id})`,
    );
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as SentRow[];
}

/**
 * Relit chez Resend l'état des emails récents encore sans issue (au plus 20 lignes de moins de 72 h, dans
 * un délai borné) et l'écrit au journal. Les ouvertures et les clics sont ignorés.
 */
async function refreshStatuses(rows: SentRow[], now: Date, fetchImpl: typeof fetch) {
  const apiKey = readResendApiKey();
  const started = Date.now();
  const candidates = rows
    .filter(
      (row) =>
        row.resend_email_id &&
        row.template_key !== "unknown" &&
        (row.status === "sent" || row.status === "delayed") &&
        now.getTime() - Date.parse(row.created_at) < REFRESH_MAX_AGE_MS,
    )
    .slice(0, REFRESH_MAX_ROWS);
  for (const row of candidates) {
    if (Date.now() - started > REFRESH_DEADLINE_MS) break;
    const result = await fetchResendEmail(apiKey, row.resend_email_id as string, fetchImpl);
    if (!result.ok) {
      if (result.failure === "expired") continue;
      return FAILURES[result.failure];
    }
    const event = ["delivered", "delivery_delayed", "bounced", "complained", "failed"].includes(
      result.data.lastEvent,
    )
      ? `email.${result.data.lastEvent}`
      : null;
    if (event) {
      await recordEmailDeliveryEvent({
        type: event,
        data: { email_id: row.resend_email_id },
      });
    }
  }
  return undefined;
}

export async function listEmailHistory({
  adminUserId,
  box,
  cursor: rawCursor,
  address: rawAddress,
  refresh = false,
  now = new Date(),
  fetchImpl = fetch,
}: {
  adminUserId: string;
  box: HistoryBox;
  cursor: string | null;
  address: string | null;
  refresh?: boolean;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<HistoryList> {
  const cursor = parseCursor(rawCursor);
  const address = parseAddress(rawAddress);

  if (box === "received") {
    const { data, error } = await supabaseAdmin.rpc("admin_email_received_list", {
      p_before_at: cursor?.at,
      p_before_id: cursor?.id,
      p_address: address ?? undefined,
      p_limit: HISTORY_PAGE_SIZE + 1,
    });
    if (error) throw error;
    const page = (data ?? []).slice(0, HISTORY_PAGE_SIZE);
    await traceAccess(adminUserId, "admin.email.list", { rows: page.length });
    return {
      rows: page.map((row) => ({
        id: `${row.source}:${row.id}`,
        at: formatDate(row.created_at),
        who: row.address || "adresse inconnue",
        subject: row.subject,
        tag:
          (row.source === "case" ? "Réponse à l’agent" : "Sans dossier") +
          (row.attachment_count > 0 ? ` · ${row.attachment_count} pièce(s)` : ""),
      })),
      next: (data ?? []).length > HISTORY_PAGE_SIZE ? cursorOf(page[page.length - 1]) : null,
    };
  }

  let rows = await readSent(cursor, address);
  let note: string | undefined;
  if (refresh) {
    note = await refreshStatuses(rows.slice(0, HISTORY_PAGE_SIZE), now, fetchImpl);
    rows = await readSent(cursor, address);
  }
  const page = rows.slice(0, HISTORY_PAGE_SIZE);
  await traceAccess(adminUserId, "admin.email.list", { rows: page.length });
  return {
    rows: page.map((row) => ({
      id: `log:${row.id}`,
      at: formatDate(row.created_at),
      who: row.to_address || "adresse inconnue",
      subject: row.subject || "(sans objet)",
      tag: rowLabel(row),
      status: sentStatus(row),
    })),
    next: rows.length > HISTORY_PAGE_SIZE ? cursorOf(page[page.length - 1]) : null,
    ...(note ? { note } : {}),
  };
}

function attachmentLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map((item) => {
    const record = (typeof item === "object" && item !== null ? item : {}) as Record<
      string,
      unknown
    >;
    const name = [record.filename, record.original_filename, record.name].find(
      (candidate): candidate is string => typeof candidate === "string" && candidate !== "",
    );
    const size = [record.size_bytes, record.size].find(
      (candidate): candidate is number => typeof candidate === "number",
    );
    return `${(name ?? "pièce jointe").slice(0, 120)}${size === undefined ? "" : ` (${Math.max(1, Math.round(size / 1024))} Ko)`}`;
  });
}

/** Texte brut sans lien d'action, borné : l'affichage ne rend jamais de HTML pour un email reçu. */
const plain = (value: string | null | undefined, max = 16_000) =>
  maskActionLinks(value ?? "").slice(0, max);

export async function readEmailMessage({
  adminUserId,
  id,
  fetchImpl = fetch,
}: {
  adminUserId: string;
  id: string;
  fetchImpl?: typeof fetch;
}): Promise<HistoryMessage | null> {
  const separator = id.indexOf(":");
  const source = id.slice(0, separator);
  const rowId = id.slice(separator + 1);
  if (separator < 0 || !ID_PATTERN.test(rowId) || !["log", "case", "unrouted"].includes(source)) {
    throw new EmailHistoryInputError("Identifiant invalide.");
  }

  if (source === "case") {
    const { data, error } = await supabaseAdmin
      .from("information_agent_messages")
      .select("id,from_email,subject,body_text,attachments,created_at")
      .eq("id", rowId)
      .eq("direction", "inbound")
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    await traceAccess(adminUserId, "admin.email.view", { targetId: rowId });
    return {
      title: data.subject,
      lines: [`De : ${data.from_email ?? "inconnu"}`, `Reçu le ${formatDate(data.created_at)}`],
      kind: "text",
      body: plain(data.body_text),
      attachments: attachmentLabels(data.attachments),
    };
  }

  if (source === "unrouted") {
    const { data, error } = await supabaseAdmin
      .from("information_agent_unrouted_messages")
      .select("id,sender,subject,excerpt,reason,attachment_count,created_at")
      .eq("id", rowId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    await traceAccess(adminUserId, "admin.email.view", { targetId: rowId });
    return {
      title: data.subject,
      lines: [
        `De : ${data.sender || "inconnu"}`,
        `Reçu le ${formatDate(data.created_at)} · sans dossier ouvert (${data.reason})`,
      ],
      kind: data.excerpt ? "text" : "note",
      body: data.excerpt ? plain(data.excerpt, 1_000) : "Extrait non conservé.",
      attachments:
        data.attachment_count > 0 ? [`${data.attachment_count} pièce(s), noms non conservés`] : [],
    };
  }

  const { data: row, error } = await supabaseAdmin
    .from("email_send_log")
    .select(
      "id,created_at,template_key,category,to_address,subject,status,bounce_type,resend_email_id",
    )
    .eq("id", rowId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return null;
  await traceAccess(adminUserId, "admin.email.view", { targetId: rowId });
  const status = sentStatus(row);
  const lines = [
    `À : ${row.to_address}`,
    `Envoyé le ${formatDate(row.created_at)} · ${rowLabel(row)} · ${status.text}${status.detail ? ` (${status.detail})` : ""}`,
  ];
  const base = { title: row.subject || "(sans objet)", lines, attachments: [] as string[] };

  // Ligne sans gabarit : email venu d'un autre outil du même compte Resend (par exemple le SMTP de Supabase Auth,
  // dont les messages portent des codes à usage unique). Son contenu n'est jamais lu chez Resend.
  if (row.template_key === "unknown") {
    return {
      ...base,
      kind: "note",
      body: authEmailLabel(row)
        ? "Email de compte envoyé par le service d’authentification : contenu non affiché."
        : "Email non émis par Immojudis : contenu non affiché.",
    };
  }

  // Envois de l'agent d'information : le texte est celui du dossier (information_agent_messages).
  if (row.category === "agent" && row.resend_email_id) {
    const { data: message, error: messageError } = await supabaseAdmin
      .from("information_agent_messages")
      .select("subject,body_text,attachments")
      .eq("provider_message_id", row.resend_email_id)
      .maybeSingle();
    if (messageError) throw messageError;
    if (message) {
      return {
        ...base,
        title: message.subject,
        kind: "text",
        body: plain(message.body_text),
        attachments: attachmentLabels(message.attachments),
      };
    }
  }

  if (!row.resend_email_id) {
    return { ...base, kind: "note", body: "Aucun identifiant Resend : contenu indisponible." };
  }
  const content = await fetchResendEmail(readResendApiKey(), row.resend_email_id, fetchImpl);
  if (!content.ok) return { ...base, kind: "note", body: FAILURES[content.failure] };
  // HTML reconstruit à partir d'une liste blanche ; s'il est impossible ou vide, la version texte, masquée.
  const document = content.data.html ? toInertEmailDocument(content.data.html) : null;
  if (document) return { ...base, kind: "html", body: document };
  if (content.data.text) return { ...base, kind: "text", body: plain(content.data.text) };
  return { ...base, kind: "note", body: "Contenu non affichable." };
}
