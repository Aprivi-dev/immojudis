import "server-only";
import type { ResendEmailMessage } from "@/lib/email-alerts";
import { emailClickUrl, isEmailClickSaleId } from "@/lib/email-click-token";
import { createUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import { escapeHtml } from "@/lib/guards";
import { SALE_CALENDAR_DISCLAIMER } from "@/lib/sale-calendar";
import { emailLayout, emailParagraph, emailSaleCard } from "@/lib/email-layout";

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
  // Liens suivis (point 65) : redirection signée qui mesure le clic pour ce compte, puis mène à la
  // même page. Un identifiant de vente qui n'est pas un UUID garde le lien direct.
  const trackedUrl = (item: SaleReminderItem, target: "sale" | "calendar", directPath: string) =>
    isEmailClickSaleId(item.saleId)
      ? emailClickUrl({ appUrl, userId, kind: "reminder", target, saleId: item.saleId, now, env })
      : `${appUrl}${directPath}`;
  const saleUrl = (item: SaleReminderItem) =>
    trackedUrl(item, "sale", `/sales/${encodeURIComponent(item.saleId.toLowerCase())}`);
  const calendarUrl = (item: SaleReminderItem) =>
    trackedUrl(
      item,
      "calendar",
      `/api/sales/${encodeURIComponent(item.saleId.toLowerCase())}/calendar`,
    );
  const subject = saleReminderSubject(items, internal);
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
    subject,
    text: textLines.join("\n"),
    html: buildSaleReminderHtml({
      title: subject,
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
  title,
  intro,
  items,
  unsubscribeUrl,
  settingsUrl,
}: {
  /** L'objet du message, repris dans `<title>`. */
  title: string;
  intro: string;
  items: Array<SaleReminderItem & { url: string; calendarUrl: string | null }>;
  unsubscribeUrl: string;
  settingsUrl: string;
}): string {
  const cards = items
    .map((item) =>
      emailSaleCard({
        eyebrow: item.headline,
        title: item.title,
        location: item.location,
        facts: item.detail ? [{ value: item.detail }] : [],
        notesHtml:
          item.detail && AUDIENCE_KINDS.has(item.kind)
            ? emailParagraph(escapeHtml(SALE_CALENDAR_DISCLAIMER), {
                tone: "muted",
                size: "caption",
                marginBottom: 12,
              })
            : "",
        action: { href: item.url, text: "Voir l’annonce" },
        secondaryLink: item.calendarUrl
          ? { href: item.calendarUrl, text: "Ajouter à mon agenda" }
          : null,
      }),
    )
    .join("");
  const [first] = items;
  const preheader =
    items.length === 1
      ? [first.headline, first.detail].filter(Boolean).join(" · ")
      : intro.replace(/\s*:$/, ".");

  return emailLayout({
    title,
    preheader,
    content: [
      emailParagraph("Bonjour,", { marginBottom: 8 }),
      emailParagraph(escapeHtml(intro), { marginBottom: 20 }),
      cards,
      emailParagraph(escapeHtml(SALE_REMINDER_DISCLAIMER), {
        tone: "muted",
        size: "caption",
        marginBottom: 0,
      }),
    ].join(""),
    footer: {
      reason: "Vous recevez ce message parce que vous avez activé les rappels d’audience.",
      links: [
        { text: "Gérer mes notifications", href: settingsUrl },
        { text: "Se désinscrire des rappels", href: unsubscribeUrl },
      ],
    },
  });
}
