import "server-only";
import type { ResendEmailMessage } from "@/lib/email-alerts";
import { emailClickUrl, isEmailClickSaleId } from "@/lib/email-click-token";
import { createUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import { formatDate } from "@/lib/format";
import { escapeHtml } from "@/lib/guards";
import { SALE_REMINDER_DISCLAIMER } from "@/lib/sale-reminder-emails";
import type { SurenchereWindow } from "@/lib/surenchere-window";
import { emailLayout, emailParagraph, emailSaleCard } from "@/lib/email-layout";

/**
 * Email de l'alerte de résultat ou de remise en vente d'une vente suivie : « la vente que vous suivez
 * a eu lieu : résultat connu ou non », « retirée ou annulée », « remise en vente ».
 *
 * JAMAIS DE PRIX dans cet email (règle Licitor) : ni mise à prix, ni prix d'adjudication, ni montant
 * de surenchère. Il dit seulement qu'un résultat est connu et renvoie vers la fiche ou « Mes favoris »,
 * où l'affichage applique les droits du compte. Aucune adresse du bien.
 *
 * Même gabarit que les rappels d'audience : carte blanche, lien de désinscription signé (portée
 * `sale-results`, aussi en en-tête `List-Unsubscribe`, RFC 8058), liens des fiches suivis par la
 * redirection signée (type `result`).
 *
 * Pas de type « non adjugée » : aucune source ne distingue une vente non adjugée d'un résultat inconnu
 * (`result_unknown`), et Immojudis n'affirme pas ce qu'il ne sait pas.
 */

export type SaleResultKind = "result_known" | "result_unknown" | "withdrawn" | "relisted";

export type SaleResultItem = {
  kind: SaleResultKind;
  saleId: string;
  /** « Maison à Bordeaux », sans adresse. */
  title: string;
  /** Tribunal ou commune, déjà public. */
  location: string;
  headline: string;
  detail: string | null;
  /**
   * Fenêtre de surenchère indicative (instantané après l'audience seulement). Rendue par
   * `surenchereLines` avec la formulation prudente de `PastFollowedSales`.
   */
  surenchere: SurenchereWindow | null;
  /**
   * Où mène le lien : la fiche de la vente (encore en ligne), ou « Mes favoris » (la vente a quitté
   * le catalogue : son résumé est dans « Ventes passées »).
   */
  link: "sale" | "favorites";
};

export const SALE_RESULT_HEADLINES: Record<SaleResultKind, string> = {
  result_known: "La vente que vous suivez a eu lieu : un résultat est connu",
  result_unknown: "La vente que vous suivez a eu lieu : résultat non connu",
  withdrawn: "La vente que vous suivez est retirée ou annulée",
  relisted: "La vente que vous suivez est remise en vente",
};

export const SALE_RESULT_DETAILS: Record<SaleResultKind, { sale: string; favorites: string }> = {
  result_known: {
    sale: "Consultez la fiche de la vente.",
    favorites: "Retrouvez cette vente dans « Mes favoris », rubrique « Ventes passées ».",
  },
  result_unknown: {
    sale: "Immojudis ne connaît pas encore le résultat de l’adjudication. Vérifiez-le auprès de l’avocat poursuivant.",
    favorites:
      "Immojudis ne connaît pas encore le résultat de l’adjudication. Vérifiez-le auprès de l’avocat poursuivant.",
  },
  withdrawn: {
    sale: "Statut à vérifier auprès de l’avocat poursuivant.",
    favorites: "Statut à vérifier auprès de l’avocat poursuivant.",
  },
  relisted: {
    sale: "La vente figure à nouveau parmi les ventes à venir. La date de la nouvelle audience est à vérifier auprès de l’avocat poursuivant.",
    favorites:
      "La vente figure à nouveau parmi les ventes à venir. La date de la nouvelle audience est à vérifier auprès de l’avocat poursuivant.",
  },
};

/**
 * Les lignes de la mention de surenchère, d'après la formulation prudente de
 * `src/components/PastFollowedSales.tsx` (texte de la relecture juridique du 20/10/2026, à faire
 * valider par un avocat) : date INDICATIVE (dix jours après l'audience connue d'Immojudis, sans
 * report éventuel), jamais « fenêtre échue », « il reste N jours » ni « dernier jour », et renvoi à
 * un avocat. Aucun montant en euros (la garantie est dite « un dixième du prix principal »). `null` quand la vente n'est pas
 * judiciaire : rien n'est dit.
 */
export function surenchereLines(info: SurenchereWindow): string[] | null {
  if (info.kind === "not_applicable") return null;
  if (info.kind === "no_date") {
    return [
      "La date d’audience n’est pas connue : la date indicative de surenchère ne peut pas être calculée. Interrogez un avocat de votre choix.",
    ];
  }
  return [
    ...(info.adjudicationConfirmed
      ? []
      : ["Le résultat n’est pas connu : la surenchère n’existe que si le bien a été adjugé."]),
    `Surenchère, date indicative : le ${formatDate(info.deadline)}. Si ce jour tombe un samedi, un dimanche ou un jour férié, le délai peut être prolongé jusqu’au premier jour ouvrable suivant ; ne comptez pas dessus sans l’avis d’un avocat. Elle est calculée à partir de la date d’audience connue d’Immojudis, qui peut avoir changé.`,
    ...(info.expired
      ? [
          "Cette date indicative est passée : le délai a pu expirer, ou être prolongé. Si vous êtes concerné, consultez sans attendre un avocat, seul à pouvoir le confirmer.",
        ]
      : []),
    "La surenchère se forme par acte d’avocat déposé au greffe du juge de l’exécution, avec une garantie d’un dixième du prix principal (chèque de banque ou caution bancaire irrévocable, art. R. 322-51 du CPCE). Faites confirmer la date et les conditions par un avocat, de préférence inscrit au barreau du tribunal concerné ; le choix vous appartient (l’annuaire d’Immojudis signale les profils mis en avant contre rémunération).",
  ];
}

/** Objet de l'email : l'élément lui-même s'il est seul, un décompte sinon. */
export function saleResultSubject(items: readonly SaleResultItem[], internal: boolean): string {
  const prefix = internal ? "[Test interne] " : "";
  if (items.length === 1) {
    const [item] = items;
    return `${prefix}${item.headline} — ${item.title}${item.location ? ` (${item.location})` : ""}`;
  }
  return `${prefix}Vos ventes suivies : ${items.length} résultats et mises à jour`;
}

export function buildSaleResultMessage({
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
  items: readonly SaleResultItem[];
  recipientEmail: string;
  from: string;
  appUrl: string;
  /** Mode d'essai (`SALE_RESULTS_MODE=internal`) : l'objet le dit. */
  internal?: boolean;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
}): ResendEmailMessage & { unsubscribeUrl: string } {
  if (items.length === 0) throw new Error("Aucune alerte de résultat à envoyer.");
  const unsubscribeUrl = `${appUrl}/api/notification-preferences/unsubscribe?token=${encodeURIComponent(
    createUnsubscribeToken({ userId, scope: { kind: "sale-results" }, now, env }),
  )}`;
  const settingsUrl = `${appUrl}/compte`;
  const favoritesUrl = `${appUrl}/favoris`;
  const directSaleUrl = (saleId: string) =>
    `${appUrl}/sales/${encodeURIComponent(saleId.toLowerCase())}`;
  const linkOf = (item: SaleResultItem) => {
    if (item.link === "favorites") return favoritesUrl;
    // Lien suivi (point 65) ; un identifiant qui n'est pas un UUID garde le lien direct.
    return isEmailClickSaleId(item.saleId)
      ? emailClickUrl({
          appUrl,
          userId,
          kind: "result",
          target: "sale",
          saleId: item.saleId,
          now,
          env,
        })
      : directSaleUrl(item.saleId);
  };
  const subject = saleResultSubject(items, internal);
  const intro =
    items.length === 1
      ? "Une vente que vous suivez sur Immojudis a évolué :"
      : "Voici ce qui concerne les ventes que vous suivez sur Immojudis :";

  const prepared = items.map((item) => ({
    ...item,
    url: linkOf(item),
    linkLabel: item.link === "favorites" ? "Voir mes favoris" : "Voir l’annonce",
    surenchereText: item.surenchere ? surenchereLines(item.surenchere) : null,
  }));

  const textLines: string[] = ["Bonjour,", "", intro, ""];
  for (const item of prepared) {
    textLines.push(
      `- ${item.headline} : ${item.title}${item.location ? ` - ${item.location}` : ""}`,
    );
    if (item.detail) textLines.push(`  ${item.detail}`);
    for (const line of item.surenchereText ?? []) textLines.push(`  ${line}`);
    textLines.push(`  ${item.linkLabel} : ${item.url}`, "");
  }
  textLines.push(
    SALE_REMINDER_DISCLAIMER,
    "",
    "Vous recevez ce message parce que vous avez activé les alertes de résultat de vos ventes suivies dans votre compte.",
    `Se désinscrire des alertes de résultat : ${unsubscribeUrl}`,
    `Gérer mes notifications : ${settingsUrl}`,
  );

  return {
    from,
    to: recipientEmail,
    subject,
    text: textLines.join("\n"),
    html: buildSaleResultHtml({
      title: subject,
      intro,
      items: prepared,
      unsubscribeUrl,
      settingsUrl,
    }),
    unsubscribeUrl,
    oneClickUnsubscribe: true,
  };
}

function buildSaleResultHtml({
  title,
  intro,
  items,
  unsubscribeUrl,
  settingsUrl,
}: {
  /** L'objet du message, repris dans `<title>`. */
  title: string;
  intro: string;
  items: Array<
    SaleResultItem & { url: string; linkLabel: string; surenchereText: string[] | null }
  >;
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
        // La mention de surenchère reste dans la carte, à la même place : seule la mise en forme change.
        notesHtml: (item.surenchereText ?? [])
          .map((line) =>
            emailParagraph(escapeHtml(line), { tone: "muted", size: "caption", marginBottom: 8 }),
          )
          .join(""),
        action: { href: item.url, text: item.linkLabel },
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
      reason:
        "Vous recevez ce message parce que vous avez activé les alertes de résultat de vos ventes suivies.",
      links: [
        { text: "Gérer mes notifications", href: settingsUrl },
        { text: "Se désinscrire des alertes de résultat", href: unsubscribeUrl },
      ],
    },
  });
}
