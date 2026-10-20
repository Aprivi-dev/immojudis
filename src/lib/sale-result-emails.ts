import "server-only";
import { escapeAttribute, type ResendEmailMessage } from "@/lib/email-alerts";
import { emailClickUrl, isEmailClickSaleId } from "@/lib/email-click-token";
import { createUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import { formatDate } from "@/lib/format";
import { escapeHtml } from "@/lib/guards";
import { SALE_REMINDER_DISCLAIMER } from "@/lib/sale-reminder-emails";
import type { SurenchereWindow } from "@/lib/surenchere-window";

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
 * Les lignes de la mention de surenchère, d'après la formulation prudente validée de
 * `src/components/PastFollowedSales.tsx` : date INDICATIVE (dix jours après l'audience connue
 * d'Immojudis, sans report éventuel), jamais « fenêtre échue », « il reste N jours » ni « dernier
 * jour », et renvoi à un avocat de son choix. Aucun montant. `null` quand la vente n'est pas
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
    `Surenchère, date indicative : le ${formatDate(info.deadline)}, ou le premier jour ouvrable suivant si ce jour tombe un samedi, un dimanche ou un jour férié. Elle est calculée à partir de la date d’audience connue d’Immojudis, qui peut avoir changé.`,
    ...(info.expired
      ? [
          "Cette date indicative est passée : si vous êtes concerné, consultez sans attendre un avocat.",
        ]
      : []),
    "La surenchère se forme par acte d’avocat : la date exacte et les conditions se confirment avec un avocat de votre choix.",
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
  const intro =
    items.length === 1
      ? "Une vente que vous suivez sur Immojudis a évolué :"
      : "Voici ce qui concerne les ventes que vous suivez sur Immojudis :";

  const prepared = items.map((item) => ({
    ...item,
    url: linkOf(item),
    linkLabel: item.link === "favorites" ? "Voir mes favoris" : "Voir l'annonce",
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
    subject: saleResultSubject(items, internal),
    text: textLines.join("\n"),
    html: buildSaleResultHtml({ intro, items: prepared, unsubscribeUrl, settingsUrl }),
    unsubscribeUrl,
    oneClickUnsubscribe: true,
  };
}

function buildSaleResultHtml({
  intro,
  items,
  unsubscribeUrl,
  settingsUrl,
}: {
  intro: string;
  items: Array<
    SaleResultItem & { url: string; linkLabel: string; surenchereText: string[] | null }
  >;
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
          ${(item.surenchereText ?? []).map((line) => `<p style="margin:0 0 8px;color:#4b5563;font-size:13px;">${escapeHtml(line)}</p>`).join("")}
          <a href="${escapeAttribute(item.url)}" style="display:inline-block;background:#182033;color:#fff;text-decoration:none;border-radius:8px;padding:10px 14px;font-weight:700;">${escapeHtml(item.linkLabel)}</a>
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
        Vous recevez ce message parce que vous avez activé les alertes de résultat de vos ventes suivies.<br />
        <a href="${escapeAttribute(settingsUrl)}" style="color:#6c7280;">Gérer mes notifications</a> ·
        <a href="${escapeAttribute(unsubscribeUrl)}" style="color:#6c7280;">Se désinscrire des alertes de résultat</a>
      </p>
    </div>
  </body>
</html>`;
}
