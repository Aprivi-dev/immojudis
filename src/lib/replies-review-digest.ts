import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ConfigurationError } from "@/lib/api-errors";
import { errorDetailForLog } from "@/lib/error-detail-for-log";
import type { ResendEmailMessage } from "@/lib/email-alerts";
import { sendTrackedEmail } from "@/lib/send-tracked-email";
import {
  emailButton,
  emailHeading,
  emailLayout,
  emailParagraph,
  emailPreheaderFrom,
} from "@/lib/email-layout";
import { serverEnv, type EnvSource } from "@/lib/env";
import { escapeHtml } from "@/lib/guards";
import {
  replaceControlCharacters,
  stripInvisibleCharacters,
} from "@/lib/information-agent-inbound/text";
import { resolveOperationalAlertEmailConfig } from "@/lib/operational-alerts";
import { parisDateKey } from "@/lib/paris-time";
import { resolveSiteOrigin } from "@/lib/site-url";

/**
 * Résumé quotidien « N réponses à relire » pour l'exploitation, appelé chaque jour par
 * `/api/cron/replies-review-digest`.
 *
 * Il compte deux choses, lues dans la base :
 * - les réponses de l'agent d'information en relecture (message reçu dont le traitement est à l'état
 *   `review`, pas encore marqué comme traité) ;
 * - les messages non rattachés (reçus à l'adresse de réponse sans dossier ouvert, pas encore traités).
 *
 * Destinataires : `OPERATIONS_ALERT_EMAIL_TO` (trois adresses au plus), JAMAIS l'expéditeur d'un message ni
 * un professionnel : ce n'est pas un message de l'agent, et il n'accuse réception de rien. Le contenu ne
 * reprend pas le corps des messages, seulement les nombres, l'expéditeur et l'objet (dix lignes au plus par
 * liste), et renvoie vers le panneau de l'agent.
 *
 * Interrupteur `REPLIES_REVIEW_DIGEST_MODE` :
 * - `off` (défaut, et toute valeur inconnue) : le passage réussit sans rien lire ni envoyer ;
 * - `preview` : les nombres sont lus et rendus dans le compte rendu du passage, aucun email ne part ;
 * - `on` : l'email part, une seule fois par jour de Paris (clé d'idempotence de Resend), et seulement
 *   s'il y a au moins une réponse ou un message à relire.
 */

const REPLIES_REVIEW_DIGEST_MODES = ["off", "preview", "on"] as const;
export type RepliesReviewDigestMode = (typeof REPLIES_REVIEW_DIGEST_MODES)[number];

/** Lignes listées au plus par catégorie : le reste n'est que compté. */
export const REPLIES_REVIEW_DIGEST_MAX_LISTED = 10;
const SENDER_MAX_CHARS = 120;
const SUBJECT_MAX_CHARS = 140;
const PANEL_PATH = "/admin/agent-ia";
const DEFAULT_ORIGIN = "https://immojudis.com";

type Env = Pick<NodeJS.ProcessEnv, string>;

/** Un doute sur la valeur ferme l'envoi : une faute de frappe ne peut pas l'ouvrir. */
export function repliesReviewDigestMode(env: Env = process.env): RepliesReviewDigestMode {
  const mode = serverEnv(env as EnvSource).repliesReviewDigest.mode?.toLowerCase();
  return mode === "preview" || mode === "on" ? mode : "off";
}

type RepliesReviewDigestEntry = { sender: string; subject: string };
type RepliesReviewDigestSection = {
  total: number;
  entries: RepliesReviewDigestEntry[];
};
export type RepliesReviewDigestContent = {
  replies: RepliesReviewDigestSection;
  unrouted: RepliesReviewDigestSection;
};

export type RepliesReviewDigestSummary = {
  mode: RepliesReviewDigestMode;
  /** Réponses de l'agent en relecture. */
  replies: number;
  /** Messages non rattachés à traiter. */
  unrouted: number;
  /** Adresses destinataires du jour (0 s'il n'y a rien à relire ou hors du mode `on`). */
  due: number;
  sent: number;
  failed: number;
  configured: boolean;
};

/** Texte sur une ligne, sans caractère de contrôle ni préfixe de lien, borné. */
function oneLine(value: string | null | undefined, max: number): string {
  const text = replaceControlCharacters(stripInvisibleCharacters(value ?? ""))
    .replace(/\b(?:https?|ftp):\/\//gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

type DigestRow = { from_email?: string | null; sender?: string | null; subject?: string | null };

function section(rows: DigestRow[] | null, total: number | null): RepliesReviewDigestSection {
  const list = rows ?? [];
  return {
    total: total ?? list.length,
    entries: list.slice(0, REPLIES_REVIEW_DIGEST_MAX_LISTED).map((row) => ({
      sender: oneLine(row.from_email ?? row.sender, SENDER_MAX_CHARS) || "expéditeur inconnu",
      subject: oneLine(row.subject, SUBJECT_MAX_CHARS) || "(sans objet)",
    })),
  };
}

/** Lit les deux listes dans la base (service_role) : seuls l'expéditeur et l'objet sont sélectionnés. */
export async function loadRepliesReviewDigest(): Promise<RepliesReviewDigestContent> {
  const [replies, unrouted] = await Promise.all([
    supabaseAdmin
      .from("information_agent_messages")
      .select("from_email,subject", { count: "exact" })
      .eq("direction", "inbound")
      .eq("metadata->inbound_processing->>status", "review")
      // Une réponse marquée comme traitée dans l'écran de l'agent quitte la relecture.
      .is("metadata->>admin_handled_at", null)
      .order("received_at", { ascending: false, nullsFirst: false })
      .limit(REPLIES_REVIEW_DIGEST_MAX_LISTED),
    supabaseAdmin
      .from("information_agent_unrouted_messages")
      .select("sender,subject", { count: "exact" })
      .eq("status", "pending")
      .order("received_at", { ascending: false })
      .limit(REPLIES_REVIEW_DIGEST_MAX_LISTED),
  ]);
  if (replies.error) throw replies.error;
  if (unrouted.error) throw unrouted.error;
  return {
    replies: section(replies.data, replies.count),
    unrouted: section(unrouted.data, unrouted.count),
  };
}

export function repliesReviewDigestSubject(total: number): string {
  return `${total} ${total > 1 ? "réponses" : "réponse"} à relire`;
}

function remainder(section: RepliesReviewDigestSection): number {
  return Math.max(0, section.total - section.entries.length);
}

/**
 * L'email : les nombres, puis pour chaque catégorie l'expéditeur et l'objet, sans jamais le corps d'un
 * message. Interne : pas de pied de désinscription ni de lien d'opposition.
 */
export function buildRepliesReviewDigestMessage(
  content: RepliesReviewDigestContent,
  { from, to, panelUrl }: { from: string; to: string; panelUrl: string },
): ResendEmailMessage {
  const total = content.replies.total + content.unrouted.total;
  const subject = `[Immojudis] ${repliesReviewDigestSubject(total)}`;
  const blocks = [
    {
      title: "Réponses de l’agent en relecture",
      section: content.replies,
    },
    {
      title: "Messages non rattachés à un dossier",
      section: content.unrouted,
    },
  ].filter((block) => block.section.total > 0);

  const text = [
    repliesReviewDigestSubject(total),
    "",
    ...blocks.flatMap(({ title, section: block }) => [
      `${title} (${block.total}) :`,
      ...block.entries.map((entry) => `- ${entry.sender} · ${entry.subject}`),
      ...(remainder(block) ? [`- … et ${remainder(block)} de plus`] : []),
      "",
    ]),
    `Ouvrir le panneau de l’agent : ${panelUrl}`,
    "",
    "Le corps des messages n’est pas repris ici. Aucune réponse n’a été envoyée.",
  ].join("\n");

  const lists = blocks
    .map(({ title, section: block }) => {
      const items = block.entries
        .map(
          (entry) =>
            `<li style="margin:0 0 6px;"><strong>${escapeHtml(entry.sender)}</strong> · ${escapeHtml(entry.subject)}</li>`,
        )
        .join("");
      const more = remainder(block)
        ? `<li style="margin:0 0 6px;">… et ${remainder(block)} de plus</li>`
        : "";
      return `${emailHeading(`${title} (${block.total})`, 2, { marginTop: 18 })}<ul class="ej-body" style="margin:0 0 16px;padding:0 0 0 18px;">${items}${more}</ul>`;
    })
    .join("");

  // Email interne : le cadre commun sans pied (comme les alertes d'exploitation).
  const html = emailLayout({
    title: subject,
    preheader: emailPreheaderFrom(
      blocks.map(({ title, section: block }) => `${title} : ${block.total}`).join(" · "),
    ),
    content: [
      emailHeading(repliesReviewDigestSubject(total)),
      lists,
      emailButton(panelUrl, "Ouvrir le panneau de l’agent"),
      emailParagraph(
        "Le corps des messages n’est pas repris ici. Aucune réponse n’a été envoyée.",
        { tone: "muted", size: "caption", marginBottom: 0 },
      ),
    ].join(""),
    footer: null,
  });

  // Aucune réponse attendue : `replyTo: null` plutôt que l'adresse de contact du site.
  return { from, to, replyTo: null, subject, html, text };
}

export async function runRepliesReviewDigest({
  mode = repliesReviewDigestMode(),
  env = process.env,
  now = new Date(),
  fetchImpl = fetch,
  load = loadRepliesReviewDigest,
}: {
  mode?: RepliesReviewDigestMode;
  env?: Env;
  now?: Date;
  fetchImpl?: typeof fetch;
  load?: () => Promise<RepliesReviewDigestContent>;
} = {}): Promise<RepliesReviewDigestSummary> {
  const summary: RepliesReviewDigestSummary = {
    mode,
    replies: 0,
    unrouted: 0,
    due: 0,
    sent: 0,
    failed: 0,
    configured: true,
  };
  if (mode === "off") return summary;

  const content = await load();
  summary.replies = content.replies.total;
  summary.unrouted = content.unrouted.total;
  const total = summary.replies + summary.unrouted;
  // Rien à relire : rien n'est envoyé, quel que soit le mode.
  if (mode === "preview" || total === 0) return summary;

  const config = resolveOperationalAlertEmailConfig(env);
  if (!config) {
    summary.configured = false;
    summary.due = 1;
    return summary;
  }
  summary.due = config.to.length;
  const panelUrl = `${resolveSiteOrigin(env, DEFAULT_ORIGIN) ?? DEFAULT_ORIGIN}${PANEL_PATH}`;
  const day = parisDateKey(now);
  for (const to of config.to) {
    try {
      await sendTrackedEmail({
        apiKey: config.apiKey,
        message: buildRepliesReviewDigestMessage(content, { from: config.from, to, panelUrl }),
        // Resend ignore une clé répétée pendant 24 heures : un passage rejoué le même jour n'écrit pas deux fois.
        idempotencyKey: `replies-review-digest-${day}-${to}`.slice(0, 256),
        fetchImpl,
        category: "operations",
        templateKey: "replies_review_digest",
      });
      summary.sent += 1;
    } catch (error) {
      summary.failed += 1;
      console.warn(
        JSON.stringify({
          scope: "replies-review-digest",
          event: "send_failed",
          error: errorDetailForLog(error),
        }),
      );
    }
  }
  return summary;
}

/** Fait échouer le passage (donc la supervision) quand le résumé dû n'est pas parti. */
export function assertRepliesReviewDigestComplete(summary: RepliesReviewDigestSummary): void {
  if (!summary.configured) {
    throw new ConfigurationError(
      `Résumé des réponses à relire : ${summary.replies + summary.unrouted} à relire mais le canal email d’exploitation n’est pas configuré (OPERATIONS_ALERT_EMAIL_TO, RESEND_API_KEY, ALERT_EMAIL_FROM).`,
    );
  }
  if (summary.failed > 0) {
    throw new Error(
      `Résumé des réponses à relire : ${summary.failed} envoi(s) en échec sur ${summary.due}.`,
    );
  }
}
