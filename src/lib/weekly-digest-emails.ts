import "server-only";
import type { ResendEmailMessage } from "@/lib/email-alerts";
import { emailClickUrl, isEmailClickSaleId } from "@/lib/email-click-token";
import { createUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import { escapeHtml } from "@/lib/guards";
import { SALE_CALENDAR_DISCLAIMER } from "@/lib/sale-calendar";
import { SALE_REMINDER_DISCLAIMER } from "@/lib/sale-reminder-emails";
import {
  emailButton,
  emailHeading,
  emailLayout,
  emailLink,
  emailNoReplyText,
  emailParagraph,
  emailSaleCard,
} from "@/lib/email-layout";

/**
 * Email du récapitulatif hebdomadaire « Ma semaine » : un seul email par semaine, au jour choisi par
 * le compte, avec trois rubriques (les vides sont omises) :
 *
 * 1. mes audiences des 14 prochains jours (ventes suivies ou débloquées, dates sourcées seulement,
 *    avec la mention « à vérifier auprès de l'avocat poursuivant ») ;
 * 2. ce qui a changé sur mes ventes suivies depuis 7 jours (les libellés de `FavoriteSaleChanges`,
 *    sans montant ni date : le détail est sur la fiche) ;
 * 3. les nouvelles ventes de mon département (celui de mes alertes) ; sans alerte, un bouton
 *    « Créer une alerte ».
 *
 * Même gabarit que les rappels d'audience : carte blanche, lien de désinscription signé (portée
 * `weekly-digest`, aussi en en-tête `List-Unsubscribe`, désinscription en un clic RFC 8058), liens des
 * ventes suivis par la redirection signée (type `weekly`). Aucune adresse du bien, aucun prix.
 */

export type WeeklyDigestSaleItem = {
  saleId: string;
  /** « Maison à Bordeaux », sans adresse. */
  title: string;
  /** Tribunal ou département, déjà public. */
  location: string;
  /** Date de l'audience, ou libellé du changement ; `null` quand il n'y a rien à ajouter. */
  detail: string | null;
  /** Ce qui a changé (rubrique 2) : « Mise à prix abaissée ». */
  label?: string;
};

export type WeeklyDigestContent = {
  audiences: WeeklyDigestSaleItem[];
  /** Audiences au-delà de celles listées. */
  audiencesMore: number;
  changes: WeeklyDigestSaleItem[];
  changesMore: number;
  newSales: {
    /** Départements des alertes du compte, tels qu'enregistrés. */
    departments: string[];
    /** Nombre total de nouvelles ventes depuis 7 jours dans ces départements. */
    total: number;
    items: WeeklyDigestSaleItem[];
  };
  /** Le compte a au moins une alerte active : sinon, un bouton « Créer une alerte ». */
  hasAlert: boolean;
};

export function weeklyDigestIsEmpty(content: WeeklyDigestContent): boolean {
  return (
    content.audiences.length === 0 &&
    content.changes.length === 0 &&
    content.newSales.items.length === 0
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count > 1 ? many : one}`;
}

/** Objet de l'email : ce qu'il contient, rubrique par rubrique. */
export function weeklyDigestSubject(content: WeeklyDigestContent, internal: boolean): string {
  const prefix = internal ? "[Test interne] " : "";
  const parts = [
    content.audiences.length + content.audiencesMore > 0
      ? plural(content.audiences.length + content.audiencesMore, "audience", "audiences")
      : null,
    content.changes.length + content.changesMore > 0
      ? plural(content.changes.length + content.changesMore, "changement", "changements")
      : null,
    content.newSales.total > 0
      ? plural(content.newSales.total, "nouvelle vente", "nouvelles ventes")
      : null,
  ].filter((part): part is string => part !== null);
  return `${prefix}Ma semaine sur Immojudis${parts.length ? ` : ${parts.join(", ")}` : ""}`;
}

export function buildWeeklyDigestMessage({
  userId,
  content,
  recipientEmail,
  from,
  appUrl,
  internal = false,
  now = new Date(),
  env,
}: {
  userId: string;
  content: WeeklyDigestContent;
  recipientEmail: string;
  from: string;
  appUrl: string;
  /** Mode d'essai (`WEEKLY_DIGEST_MODE=internal`) : l'objet le dit. */
  internal?: boolean;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
}): ResendEmailMessage & { unsubscribeUrl: string } {
  if (weeklyDigestIsEmpty(content)) throw new Error("Weekly digest email: no content to send.");
  const unsubscribeUrl = `${appUrl}/api/notification-preferences/unsubscribe?token=${encodeURIComponent(
    createUnsubscribeToken({ userId, scope: { kind: "weekly-digest" }, now, env }),
  )}`;
  const settingsUrl = `${appUrl}/compte`;
  const favoritesUrl = `${appUrl}/favoris`;
  const alertsUrl = `${appUrl}/alertes`;
  // Liens suivis (point 65) : redirection signée qui mesure le clic pour ce compte, puis mène à la
  // même page. Un identifiant de vente qui n'est pas un UUID garde le lien direct.
  const directPath = (item: WeeklyDigestSaleItem, target: "sale" | "calendar") => {
    const id = encodeURIComponent(item.saleId.toLowerCase());
    return `${appUrl}${target === "calendar" ? `/api/sales/${id}/calendar` : `/sales/${id}`}`;
  };
  const tracked = (item: WeeklyDigestSaleItem, target: "sale" | "calendar") =>
    isEmailClickSaleId(item.saleId)
      ? emailClickUrl({ appUrl, userId, kind: "weekly", target, saleId: item.saleId, now, env })
      : directPath(item, target);
  const withUrls = (items: WeeklyDigestSaleItem[], calendar: boolean) =>
    items.map((item) => ({
      ...item,
      url: tracked(item, "sale"),
      calendarUrl: calendar ? tracked(item, "calendar") : null,
    }));

  const audiences = withUrls(content.audiences, true);
  const changes = withUrls(content.changes, false);
  const newSales = withUrls(content.newSales.items, false);

  const subject = weeklyDigestSubject(content, internal);
  const textLines: string[] = ["Bonjour,", "", "Voici votre semaine sur Immojudis."];
  if (audiences.length) {
    textLines.push("", "Vos audiences des 14 prochains jours", "");
    for (const item of audiences) {
      textLines.push(`- ${item.title}${item.location ? ` - ${item.location}` : ""}`);
      if (item.detail) textLines.push(`  ${item.detail}`);
      textLines.push(`  Consulter l'annonce : ${item.url}`);
      if (item.calendarUrl) textLines.push(`  Ajouter à mon agenda : ${item.calendarUrl}`);
    }
    if (content.audiencesMore > 0) {
      textLines.push(`… et ${plural(content.audiencesMore, "autre", "autres")} : ${favoritesUrl}`);
    }
    textLines.push("", SALE_CALENDAR_DISCLAIMER);
  }
  if (changes.length) {
    textLines.push("", "Ce qui a changé sur vos ventes suivies (7 derniers jours)", "");
    for (const item of changes) {
      textLines.push(`- ${item.label ?? "Changement"} : ${item.title}`);
      if (item.detail) textLines.push(`  ${item.detail}`);
      textLines.push(`  Consulter l'annonce : ${item.url}`);
    }
    if (content.changesMore > 0) {
      textLines.push(`… et ${plural(content.changesMore, "autre", "autres")} : ${favoritesUrl}`);
    }
  }
  if (newSales.length) {
    textLines.push(
      "",
      `Nouvelles ventes dans ${
        content.newSales.departments.length > 1 ? "vos départements" : "votre département"
      } (${content.newSales.departments.join(", ")}), ${plural(content.newSales.total, "vente", "ventes")} en 7 jours`,
      "",
    );
    for (const item of newSales) {
      textLines.push(`- ${item.title}${item.location ? ` - ${item.location}` : ""}`);
      textLines.push(`  Consulter l'annonce : ${item.url}`);
    }
    if (content.newSales.total > newSales.length) {
      textLines.push(`… et d'autres : ${alertsUrl}`);
    }
  }
  if (!content.hasAlert) {
    textLines.push(
      "",
      "Pour être prévenu des nouvelles ventes de votre département, créez une alerte.",
      `Créer une alerte : ${alertsUrl}`,
    );
  }
  textLines.push(
    "",
    SALE_REMINDER_DISCLAIMER,
    "",
    "Vous recevez ce message parce que vous avez activé le récapitulatif hebdomadaire « Ma semaine » dans votre compte.",
    `Se désinscrire du récapitulatif : ${unsubscribeUrl}`,
    `Gérer mes notifications : ${settingsUrl}`,
    "",
    emailNoReplyText(),
  );

  return {
    from,
    to: recipientEmail,
    // Message automatique : aucune adresse de réponse.
    replyTo: null,
    subject,
    text: textLines.join("\n"),
    html: buildWeeklyDigestHtml({
      title: subject,
      audiences,
      audiencesMore: content.audiencesMore,
      changes,
      changesMore: content.changesMore,
      newSales,
      newSalesMeta: content.newSales,
      hasAlert: content.hasAlert,
      favoritesUrl,
      alertsUrl,
      unsubscribeUrl,
      settingsUrl,
    }),
    unsubscribeUrl,
    oneClickUnsubscribe: true,
  };
}

type LinkedItem = WeeklyDigestSaleItem & { url: string; calendarUrl: string | null };

function itemHtml(item: LinkedItem): string {
  return emailSaleCard({
    eyebrow: item.label,
    title: item.title,
    location: item.location,
    facts: item.detail ? [{ value: item.detail }] : [],
    action: { href: item.url, text: "Voir l’annonce" },
    secondaryLink: item.calendarUrl
      ? { href: item.calendarUrl, text: "Ajouter à mon agenda" }
      : null,
  });
}

function sectionHtml(title: string, body: string): string {
  return `${emailHeading(title, 2, { marginTop: 24, marginBottom: 4 })}${body}`;
}

function moreHtml(count: number, href: string): string {
  return count > 0
    ? emailParagraph(
        `… et ${escapeHtml(plural(count, "autre", "autres"))} : ${emailLink(href, "Mes favoris")}`,
        { size: "fact", marginBottom: 12 },
      )
    : "";
}

function buildWeeklyDigestHtml({
  title,
  audiences,
  audiencesMore,
  changes,
  changesMore,
  newSales,
  newSalesMeta,
  hasAlert,
  favoritesUrl,
  alertsUrl,
  unsubscribeUrl,
  settingsUrl,
}: {
  /** L'objet du message, repris dans `<title>`. */
  title: string;
  audiences: LinkedItem[];
  audiencesMore: number;
  changes: LinkedItem[];
  changesMore: number;
  newSales: LinkedItem[];
  newSalesMeta: WeeklyDigestContent["newSales"];
  hasAlert: boolean;
  favoritesUrl: string;
  alertsUrl: string;
  unsubscribeUrl: string;
  settingsUrl: string;
}): string {
  const sections: string[] = [];
  if (audiences.length) {
    sections.push(
      sectionHtml(
        "Vos audiences des 14 prochains jours",
        audiences.map(itemHtml).join("") +
          moreHtml(audiencesMore, favoritesUrl) +
          emailParagraph(escapeHtml(SALE_CALENDAR_DISCLAIMER), {
            tone: "muted",
            size: "caption",
            marginBottom: 12,
          }),
      ),
    );
  }
  if (changes.length) {
    sections.push(
      sectionHtml(
        "Ce qui a changé sur vos ventes suivies (7 derniers jours)",
        changes.map(itemHtml).join("") + moreHtml(changesMore, favoritesUrl),
      ),
    );
  }
  if (newSales.length) {
    const plural1 = newSalesMeta.departments.length > 1;
    sections.push(
      sectionHtml(
        `Nouvelles ventes dans ${plural1 ? "vos départements" : "votre département"} (${newSalesMeta.departments.join(", ")})`,
        emailParagraph(`${escapeHtml(plural(newSalesMeta.total, "vente", "ventes"))} en 7 jours.`, {
          marginBottom: 4,
        }) +
          newSales.map(itemHtml).join("") +
          (newSalesMeta.total > newSales.length
            ? emailParagraph(emailLink(alertsUrl, "Gérer mes alertes"), { marginBottom: 12 })
            : ""),
      ),
    );
  }
  if (!hasAlert) {
    sections.push(
      sectionHtml(
        "Les nouvelles ventes de votre département",
        emailParagraph(
          "Créez une alerte pour être prévenu des nouvelles ventes de votre département.",
        ) + emailButton(alertsUrl, "Créer une alerte", { variant: "secondary" }),
      ),
    );
  }

  const covered = [
    audiences.length ? "vos audiences" : null,
    changes.length ? "les changements sur vos ventes suivies" : null,
    newSales.length ? "les nouvelles ventes" : null,
  ].filter((part): part is string => part !== null);

  return emailLayout({
    title,
    preheader: `Voici votre semaine sur Immojudis : ${covered.join(", ") || "vos ventes"}.`,
    content: [
      emailParagraph("Bonjour,", { marginBottom: 8 }),
      emailParagraph("Voici votre semaine sur Immojudis.", { marginBottom: 0 }),
      sections.join(""),
      emailParagraph(escapeHtml(SALE_REMINDER_DISCLAIMER), {
        tone: "muted",
        size: "caption",
        marginBottom: 0,
      }),
    ].join(""),
    footer: {
      noReply: true,
      reason:
        "Vous recevez ce message parce que vous avez activé le récapitulatif hebdomadaire « Ma semaine ».",
      links: [
        { text: "Gérer mes notifications", href: settingsUrl },
        { text: "Se désinscrire du récapitulatif", href: unsubscribeUrl },
      ],
    },
  });
}
