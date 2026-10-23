import "server-only";
import { escapeAttribute, type ResendEmailMessage } from "@/lib/email-alerts";
import { emailClickUrl, isEmailClickSaleId } from "@/lib/email-click-token";
import { createUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import { escapeHtml } from "@/lib/guards";
import { SALE_CALENDAR_DISCLAIMER } from "@/lib/sale-calendar";
import { SALE_REMINDER_DISCLAIMER } from "@/lib/sale-reminder-emails";
import { EMAIL_COLORS } from "@/lib/email-brand";

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
  if (weeklyDigestIsEmpty(content)) throw new Error("Aucun contenu pour le récapitulatif.");
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
  );

  return {
    from,
    to: recipientEmail,
    subject: weeklyDigestSubject(content, internal),
    text: textLines.join("\n"),
    html: buildWeeklyDigestHtml({
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

const BUTTON = `display:inline-block;background:${EMAIL_COLORS.navy};color:${EMAIL_COLORS.white};text-decoration:none;border-radius:8px;padding:10px 14px;font-weight:700;`;
const LINK = `display:inline-block;color:${EMAIL_COLORS.navy};text-decoration:underline;padding:10px 6px;font-weight:700;`;

function itemHtml(item: LinkedItem): string {
  return `<div style="margin:0 0 14px;padding:0 0 12px;border-bottom:1px solid ${EMAIL_COLORS.lineWarm};">
          ${item.label ? `<p style="margin:0 0 4px;color:${EMAIL_COLORS.goldText};font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">${escapeHtml(item.label)}</p>` : ""}
          <h3 style="margin:0 0 4px;font-size:16px;line-height:1.3;color:${EMAIL_COLORS.navy};">${escapeHtml(item.title)}</h3>
          ${item.location ? `<p style="margin:0 0 6px;color:${EMAIL_COLORS.inkSoft};">${escapeHtml(item.location)}</p>` : ""}
          ${item.detail ? `<p style="margin:0 0 8px;font-weight:700;color:${EMAIL_COLORS.navy};">${escapeHtml(item.detail)}</p>` : ""}
          <a href="${escapeAttribute(item.url)}" style="${BUTTON}">Voir l'annonce</a>
          ${item.calendarUrl ? ` <a href="${escapeAttribute(item.calendarUrl)}" style="${LINK}">Ajouter à mon agenda</a>` : ""}
        </div>`;
}

function sectionHtml(title: string, body: string): string {
  return `<h2 style="margin:22px 0 10px;font-size:18px;line-height:1.3;color:${EMAIL_COLORS.navy};">${escapeHtml(title)}</h2>${body}`;
}

function moreHtml(count: number, href: string): string {
  return count > 0
    ? `<p style="margin:0 0 12px;color:${EMAIL_COLORS.inkStrong};font-size:13px;">… et ${escapeHtml(plural(count, "autre", "autres"))} : <a href="${escapeAttribute(href)}" style="color:${EMAIL_COLORS.navy};">Mes favoris</a></p>`
    : "";
}

function buildWeeklyDigestHtml({
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
          `<p style="margin:0 0 12px;color:${EMAIL_COLORS.inkStrong};font-size:13px;">${escapeHtml(SALE_CALENDAR_DISCLAIMER)}</p>`,
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
        `<p style="margin:0 0 12px;color:${EMAIL_COLORS.inkStrong};">${escapeHtml(plural(newSalesMeta.total, "vente", "ventes"))} en 7 jours.</p>` +
          newSales.map(itemHtml).join("") +
          (newSalesMeta.total > newSales.length
            ? `<p style="margin:0 0 12px;"><a href="${escapeAttribute(alertsUrl)}" style="color:${EMAIL_COLORS.navy};">Gérer mes alertes</a></p>`
            : ""),
      ),
    );
  }
  if (!hasAlert) {
    sections.push(
      sectionHtml(
        "Les nouvelles ventes de votre département",
        `<p style="margin:0 0 12px;color:${EMAIL_COLORS.inkStrong};">Créez une alerte pour être prévenu des nouvelles ventes de votre département.</p><a href="${escapeAttribute(alertsUrl)}" style="${BUTTON}">Créer une alerte</a>`,
      ),
    );
  }

  return `<!doctype html>
<html lang="fr">
  <body style="margin:0;background:${EMAIL_COLORS.surface};color:${EMAIL_COLORS.navy};font-family:Arial,sans-serif;">
    <div style="max-width:620px;margin:0 auto;padding:28px 18px;">
      <div style="background:#fff;border:1px solid ${EMAIL_COLORS.lineWarm};border-radius:10px;padding:24px;">
        <p style="margin:0 0 8px;font-size:16px;">Bonjour,</p>
        <p style="margin:0;color:${EMAIL_COLORS.inkStrong};">Voici votre semaine sur Immojudis.</p>
        ${sections.join("\n        ")}
        <p style="margin:18px 0 0;color:${EMAIL_COLORS.inkSoft};font-size:12px;line-height:1.5;">${escapeHtml(SALE_REMINDER_DISCLAIMER)}</p>
      </div>
      <p style="margin:14px 0 0;text-align:center;color:${EMAIL_COLORS.inkSoft};font-size:12px;line-height:1.5;">
        Vous recevez ce message parce que vous avez activé le récapitulatif hebdomadaire « Ma semaine ».<br />
        <a href="${escapeAttribute(settingsUrl)}" style="color:${EMAIL_COLORS.inkSoft};">Gérer mes notifications</a> ·
        <a href="${escapeAttribute(unsubscribeUrl)}" style="color:${EMAIL_COLORS.inkSoft};">Se désinscrire du récapitulatif</a>
      </p>
    </div>
  </body>
</html>`;
}
