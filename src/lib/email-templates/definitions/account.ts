import {
  SAMPLE_ALERT_A,
  SAMPLE_ALERT_B,
  SAMPLE_APP_URL,
  SAMPLE_ENV,
  SAMPLE_FROM,
  SAMPLE_NOW,
  SAMPLE_RECIPIENT,
  SAMPLE_SALE_A,
  SAMPLE_SALE_B,
  SAMPLE_SALE_C,
  SAMPLE_USER_ID,
  variantFromMessage,
} from "../samples";
import type { EmailTemplateDefinition } from "../types";

/**
 * Emails envoyés aux comptes au nom des alertes : alertes de recherche, rappels d'audience,
 * récapitulatif hebdomadaire, résultats de vente, fin de l'essai, ouverture de l'offre Analyse.
 * Expéditeur : `NOREPLY_EMAIL_FROM` (« ne pas répondre », aucun Reply-To ; repli sur `ALERT_EMAIL_FROM`).
 */

const common = {
  userId: SAMPLE_USER_ID,
  recipientEmail: SAMPLE_RECIPIENT,
  from: SAMPLE_FROM,
  appUrl: SAMPLE_APP_URL,
  now: SAMPLE_NOW,
  env: SAMPLE_ENV,
} as const;

function digestNotification(
  id: string,
  saleId: string,
  alertId: string,
  alertName: string,
  sale: Record<string, string | number>,
  match: Record<string, unknown>,
) {
  return {
    id,
    alert_id: alertId,
    sale_id: saleId,
    notification_snapshot: {
      alert: { id: alertId, name: alertName },
      sale: { id: saleId, ...sale },
      match,
    },
  } as never;
}

const alert: EmailTemplateDefinition = {
  key: "alert",
  label: "Alerte de recherche",
  description:
    "Une alerte du compte trouve une ou plusieurs ventes (regroupées dans un seul email).",
  category: "alert",
  sender: "NOREPLY_EMAIL_FROM",
  level: "editable",
  async sample() {
    const { buildAlertDigestMessage } = await import("@/lib/email-alerts");
    const single = buildAlertDigestMessage({
      ...common,
      notifications: [
        digestNotification(
          "a1",
          SAMPLE_SALE_A,
          SAMPLE_ALERT_A,
          "Bordeaux - appartements",
          {
            title: "Appartement T3 de 68 m²",
            city: "Bordeaux",
            department: "33",
            saleDate: "2026-12-10T10:00:00Z",
            startingPriceEur: 95000,
          },
          { reasons: ["département 33", "prix maximum 120 000 €"], marketDiscountPct: 34.6 },
        ),
      ],
      alertActivatedAt: new Map([[SAMPLE_ALERT_A, "2026-10-20T10:00:00Z"]]),
    });
    const many = buildAlertDigestMessage({
      ...common,
      notifications: Array.from({ length: 13 }, (_, index) =>
        digestNotification(
          `m${index}`,
          index % 2 ? SAMPLE_SALE_B : SAMPLE_SALE_C,
          index < 7 ? SAMPLE_ALERT_B : SAMPLE_ALERT_A,
          index < 7 ? "Pépites en Gironde" : "Rendement > 8 %",
          {
            title: `Maison avec jardin n°${index + 1}`,
            city: "Libourne",
            department: "33",
            saleDate: `2026-12-1${index % 9}T10:00:00Z`,
            startingPriceEur: 60000 + index * 1000,
          },
          {
            reasons: index < 7 ? ["pépite", "département 33"] : ["rendement"],
            marketDiscountPct: index < 7 ? 41 : null,
          },
        ),
      ),
    });
    return [
      variantFromMessage("one-sale", "Une vente", single),
      variantFromMessage("many-sales", "Plusieurs ventes (liste tronquée à 10)", many),
    ];
  },
};

const saleReminder: EmailTemplateDefinition = {
  key: "sale_reminder",
  label: "Rappel d’audience",
  description: "Audience dans 7 jours ou demain, date modifiée, vente retirée ou reportée.",
  category: "reminder",
  sender: "NOREPLY_EMAIL_FROM",
  level: "editable",
  async sample() {
    const { buildSaleReminderMessage } = await import("@/lib/sale-reminder-emails");
    const location = "Tribunal judiciaire de Bordeaux";
    const one = buildSaleReminderMessage({
      ...common,
      items: [
        {
          kind: "audience_j7",
          saleId: SAMPLE_SALE_A,
          title: "Maison à Bordeaux",
          location,
          headline: "Votre audience est dans 7 jours",
          detail: "Audience le 9 novembre 2026",
        },
      ],
    });
    const several = buildSaleReminderMessage({
      ...common,
      internal: true,
      items: [
        {
          kind: "audience_j1",
          saleId: SAMPLE_SALE_A,
          title: "Maison à Bordeaux",
          location,
          headline: "Votre audience est demain",
          detail: "Audience le 3 novembre 2026",
        },
        {
          kind: "date_changed",
          saleId: SAMPLE_SALE_B,
          title: "Appartement à Lyon",
          location: "Tribunal judiciaire de Lyon",
          headline: "Date modifiée",
          detail: "Du 12 novembre 2026 au 3 décembre 2026",
        },
        {
          kind: "status_changed",
          saleId: SAMPLE_SALE_C,
          title: "Immeuble à Lille",
          location: "Lille",
          headline: "Vente retirée",
          detail: null,
        },
      ],
    });
    return [
      variantFromMessage("one-sale", "Une vente", one),
      variantFromMessage("many-sales-internal", "Plusieurs ventes, mode essai interne", several),
    ];
  },
};

const weeklyDigest: EmailTemplateDefinition = {
  key: "weekly_digest",
  label: "Récapitulatif hebdomadaire",
  description: "Chaque semaine : audiences à venir, changements, nouvelles ventes des alertes.",
  category: "weekly",
  sender: "NOREPLY_EMAIL_FROM",
  level: "editable",
  async sample() {
    const { buildWeeklyDigestMessage } = await import("@/lib/weekly-digest-emails");
    const item = (
      saleId: string,
      title: string,
      location: string,
      detail: string | null,
      label?: string,
    ) => ({ saleId, title, location, detail, label });
    const message = buildWeeklyDigestMessage({
      ...common,
      content: {
        audiences: [
          item(
            SAMPLE_SALE_A,
            "Maison à Bordeaux",
            "Tribunal judiciaire de Bordeaux",
            "Audience le 9 novembre 2026",
          ),
        ],
        audiencesMore: 2,
        changes: [item(SAMPLE_SALE_B, "Appartement à Lyon", "Lyon", null, "Mise à prix abaissée")],
        changesMore: 0,
        newSales: {
          departments: ["33", "40"],
          total: 14,
          items: [item(SAMPLE_SALE_C, "Studio à Mérignac", "Mérignac · 33", null)],
        },
        hasAlert: false,
      },
    });
    return [variantFromMessage("digest", "Récapitulatif complet", message)];
  },
};

const saleResult: EmailTemplateDefinition = {
  key: "sale_result",
  label: "Résultat d’une vente suivie",
  description: "Une vente suivie a eu lieu, a été retirée ou est remise en vente (jamais de prix).",
  category: "result",
  sender: "NOREPLY_EMAIL_FROM",
  level: "editable",
  async sample() {
    const { buildSaleResultMessage } = await import("@/lib/sale-result-emails");
    const message = buildSaleResultMessage({
      ...common,
      items: [
        {
          kind: "result_known",
          saleId: SAMPLE_SALE_A,
          title: "Maison à Bordeaux",
          location: "Tribunal judiciaire de Bordeaux",
          headline: "La vente que vous suivez a eu lieu : un résultat est connu",
          detail: "Consultez la fiche de la vente.",
          surenchere: {
            kind: "window",
            hearingDay: "2026-10-20",
            deadline: "2026-10-30",
            adjudicationConfirmed: true,
            expired: false,
          },
          link: "sale",
        },
        {
          kind: "relisted",
          saleId: SAMPLE_SALE_B,
          title: "Appartement à Lyon",
          location: "Lyon",
          headline: "La vente que vous suivez est remise en vente",
          detail:
            "La vente figure à nouveau parmi les ventes à venir. La date de la nouvelle audience est à vérifier auprès de l’avocat poursuivant.",
          surenchere: null,
          link: "favorites",
        },
      ],
    });
    return [variantFromMessage("two-results", "Résultat connu et remise en vente", message)];
  },
};

const trialEnd: EmailTemplateDefinition = {
  key: "trial_end",
  label: "Fin de l’accès offert",
  description: "Prévient le compte que l’offre de lancement se termine bientôt.",
  category: "launch_offer_end",
  sender: "NOREPLY_EMAIL_FROM",
  level: "editable",
  async sample() {
    const { buildTrialEndMessage } = await import("@/lib/trial-end-email");
    const normal = await buildTrialEndMessage({ ...common, endsAt: "2026-11-14T10:00:00Z" });
    const internal = await buildTrialEndMessage({
      ...common,
      endsAt: "2026-11-01T10:00:00Z",
      internal: true,
    });
    return [
      variantFromMessage("normal", "Envoi réel", normal),
      variantFromMessage("internal", "Mode essai interne", internal),
    ];
  },
};

const offerOpening: EmailTemplateDefinition = {
  key: "offer_opening",
  label: "Ouverture de l’offre Analyse",
  description: "Envoyé une seule fois aux personnes qui ont demandé à être prévenues.",
  category: "opening",
  sender: "NOREPLY_EMAIL_FROM",
  level: "editable",
  async sample() {
    const { buildOfferOpeningMessage, offerOpeningUnsubscribeUrl } =
      await import("@/lib/admin-offer-opening-notifier");
    const unsubscribeUrl = offerOpeningUnsubscribeUrl({
      appUrl: SAMPLE_APP_URL,
      userId: SAMPLE_USER_ID,
      now: SAMPLE_NOW,
      env: SAMPLE_ENV,
    });
    const message = buildOfferOpeningMessage({
      recipientEmail: SAMPLE_RECIPIENT,
      from: SAMPLE_FROM,
      appUrl: SAMPLE_APP_URL,
      unsubscribeUrl,
    });
    return [variantFromMessage("opening", "Envoi réel", message)];
  },
};

export const ACCOUNT_EMAIL_TEMPLATES: readonly EmailTemplateDefinition[] = [
  alert,
  saleReminder,
  weeklyDigest,
  saleResult,
  trialEnd,
  offerOpening,
];
