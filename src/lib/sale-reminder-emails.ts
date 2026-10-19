import "server-only";
import { escapeAttribute, type ResendEmailMessage } from "@/lib/email-alerts";
import { createUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import { escapeHtml } from "@/lib/guards";
import { SALE_CALENDAR_DISCLAIMER } from "@/lib/sale-calendar";

/**
 * Email des rappels d'audience (J-7, J-1) et des avertissements graves (date modifiée, vente
 * retirée, reportée ou adjugée) sur les ventes qu'une personne suit.
 *
 * Même gabarit que le récapitulatif des alertes (`email-alerts.ts`) : carte blanche, bouton « Voir
 * l'annonce », lien de désinscription signé (portée « reminders ») repris dans l'en-tête
 * `List-Unsubscribe` (désinscription en un clic, RFC 8058). Aucune adresse du bien n'y figure :
 * seulement ce que montre la page publique de la vente.
 */

export type SaleReminderKind = "audience_j7" | "audience_j1" | "date_changed" | "status_changed";

export type SaleReminderItem = {
  kind: SaleReminderKind;
  saleId: string;
  /** « Maison à Bordeaux », sans adresse. */
  title: string;
  /** Tribunal ou commune, déjà public. */
  location: string;
  /** « Votre audience est dans 7 jours », « Votre audience est demain », « Vente reportée »… */
  headline: string;
  /** Date de l'audience ou ancienne et nouvelle date, déjà formatées ; `null` sans date sourcée. */
  detail: string | null;
};

export const SALE_REMINDER_DISCLAIMER =
  "Ces informations viennent des annonces collectées et peuvent évoluer ; elles ne constituent pas un conseil juridique. Vérifiez la date et le statut de la vente auprès de l’avocat poursuivant avant tout déplacement.";

const AUDIENCE_KINDS: ReadonlySet<SaleReminderKind> = new Set(["audience_j7", "audience_j1"]);

/** Objet de l'email : l'élément lui-même s'il est seul, un décompte sinon. */
export function saleReminderSubject(items: readonly SaleReminderItem[], internal: boolean): string {
  const prefix = internal ? "[Test interne] " : "";
  if (items.length === 1) {
    const [item] = items;
    return `${prefix}${item.headline} — ${item.title}${item.location ? ` (${item.location})` : ""}`;
  }
  return `${prefix}Vos ventes suivies : ${items.length} rappels et changements`;
}

export function buildSaleReminderMessage({
  userId,
  items,
  recipientEmail,
  from,
  appUrl,
  internal = false,
  now = new Date(),
  env,
}: {
  userId: string;
  items: readonly SaleReminderItem[];
  recipientEmail: string;
  from: string;
  appUrl: string;
  /** Mode d'essai (`SALE_REMINDERS_MODE=internal`) : l'objet le dit. */
  internal?: boolean;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
}): ResendEmailMessage & { unsubscribeUrl: string } {
  if (items.length === 0) throw new Error("Aucun rappel à envoyer.");
  const unsubscribeUrl = `${appUrl}/api/notification-preferences/unsubscribe?token=${encodeURIComponent(
    createUnsubscribeToken({ userId, scope: { kind: "reminders" }, now, env }),
  )}`;
  const settingsUrl = `${appUrl}/compte`;
  const saleUrl = (item: SaleReminderItem) =>
    `${appUrl}/sales/${encodeURIComponent(item.saleId.toLowerCase())}`;
  const calendarUrl = (item: SaleReminderItem) =>
    `${appUrl}/api/sales/${encodeURIComponent(item.saleId.toLowerCase())}/calendar`;
  const intro =
    items.length === 1
      ? "Une vente que vous suivez sur Immojudis demande votre attention :"
      : "Voici ce qui concerne les ventes que vous suivez sur Immojudis :";

  const textLines: string[] = ["Bonjour,", "", intro, ""];
  for (const item of items) {
    textLines.push(
      `- ${item.headline} : ${item.title}${item.location ? ` - ${item.location}` : ""}`,
    );
    if (item.detail) textLines.push(`  ${item.detail}`);
    if (item.detail && AUDIENCE_KINDS.has(item.kind)) {
      textLines.push(`  ${SALE_CALENDAR_DISCLAIMER}`);
    }
    textLines.push(`  Consulter l'annonce : ${saleUrl(item)}`);
    if (AUDIENCE_KINDS.has(item.kind)) {
      textLines.push(`  Ajouter à mon agenda : ${calendarUrl(item)}`);
    }
    textLines.push("");
  }
  textLines.push(
    SALE_REMINDER_DISCLAIMER,
    "",
    "Vous recevez ce message parce que vous avez activé les rappels d'audience dans votre compte.",
    `Se désinscrire des rappels : ${unsubscribeUrl}`,
    `Gérer mes notifications : ${settingsUrl}`,
  );

  return {
    from,
    to: recipientEmail,
    subject: saleReminderSubject(items, internal),
    text: textLines.join("\n"),
    html: buildSaleReminderHtml({
      intro,
      items: items.map((item) => ({
        ...item,
        url: saleUrl(item),
        calendarUrl: AUDIENCE_KINDS.has(item.kind) ? calendarUrl(item) : null,
      })),
      unsubscribeUrl,
      settingsUrl,
    }),
    unsubscribeUrl,
    oneClickUnsubscribe: true,
  };
}

function buildSaleReminderHtml({
  intro,
  items,
  unsubscribeUrl,
  settingsUrl,
}: {
  intro: string;
  items: Array<SaleReminderItem & { url: string; calendarUrl: string | null }>;
  unsubscribeUrl: string;
  settingsUrl: string;
}): string {
  const sections = items
    .map(
      (item) => `<div style="margin:0 0 18px;padding:0 0 16px;border-bottom:1px solid #eee7d8;">
          <p style="margin:0 0 6px;color:#7a5f1f;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">${escapeHtml(item.headline)}</p>
          <h2 style="margin:0 0 4px;font-size:18px;line-height:1.3;color:#182033;">${escapeHtml(item.title)}</h2>
          ${item.location ? `<p style="margin:0 0 8px;color:#6c7280;">${escapeHtml(item.location)}</p>` : ""}
          ${item.detail ? `<p style="margin:0 0 8px;font-weight:700;color:#182033;">${escapeHtml(item.detail)}</p>` : ""}
          ${
            item.detail && AUDIENCE_KINDS.has(item.kind)
              ? `<p style="margin:0 0 12px;color:#4b5563;font-size:13px;">${escapeHtml(SALE_CALENDAR_DISCLAIMER)}</p>`
              : ""
          }
          <a href="${escapeAttribute(item.url)}" style="display:inline-block;background:#182033;color:#fff;text-decoration:none;border-radius:8px;padding:10px 14px;font-weight:700;">Voir l'annonce</a>
          ${
            item.calendarUrl
              ? ` <a href="${escapeAttribute(item.calendarUrl)}" style="display:inline-block;color:#182033;text-decoration:underline;padding:10px 6px;font-weight:700;">Ajouter à mon agenda</a>`
              : ""
          }
        </div>`,
    )
    .join("");

  return `<!doctype html>
<html lang="fr">
  <body style="margin:0;background:#f6f4ef;color:#182033;font-family:Arial,sans-serif;">
    <div style="max-width:620px;margin:0 auto;padding:28px 18px;">
      <div style="background:#fff;border:1px solid #e8e1d4;border-radius:10px;padding:24px;">
        <p style="margin:0 0 8px;font-size:16px;">Bonjour,</p>
        <p style="margin:0 0 18px;color:#4b5563;">${escapeHtml(intro)}</p>
        ${sections}
        <p style="margin:12px 0 0;color:#6c7280;font-size:12px;line-height:1.5;">${escapeHtml(SALE_REMINDER_DISCLAIMER)}</p>
      </div>
      <p style="margin:14px 0 0;text-align:center;color:#6c7280;font-size:12px;line-height:1.5;">
        Vous recevez ce message parce que vous avez activé les rappels d'audience.<br />
        <a href="${escapeAttribute(settingsUrl)}" style="color:#6c7280;">Gérer mes notifications</a> ·
        <a href="${escapeAttribute(unsubscribeUrl)}" style="color:#6c7280;">Se désinscrire des rappels</a>
      </p>
    </div>
  </body>
</html>`;
}
