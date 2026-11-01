import { EMAIL_BRAND_NAME } from "../src/lib/email-brand";
import {
  emailHeading,
  emailEyebrow,
  emailLayout,
  emailLink,
  emailPanel,
  emailParagraph,
  escapeEmailHtml,
} from "../src/lib/email-layout";

/**
 * Email unique de fin d'essai gratuit (J+5), sans pression : ce qui reste gratuit, ce qui se ferme,
 * le fait que rien ne devient payant, et un seul lien (« Être prévenu de l’ouverture »). Pas de compte
 * à rebours, pas de réduction, pas d'appel à s'abonner. Le texte vient de `src/lib/trial-end-email.ts`
 * (et des listes de `launch-offer-end-lists.ts`, les mêmes que le bloc de /compte) ; ici seulement la
 * mise en forme, par le modèle unique `emailLayout()` (`src/lib/email-layout.ts`) : logo, carte, pied
 * et mode sombre sont ceux de tous les emails.
 */
export type TrialEndEmailProps = {
  /** « 14 novembre 2026 » : le jour de Paris où l'essai du compte se termine. */
  endsOnLabel: string;
  stays: readonly string[];
  needsAnalysis: readonly string[];
  /** Ce que deviennent les données du compte. */
  dataText: string;
  /** « Rien ne devient payant automatiquement… » */
  noChargeText: string;
  openingUrl: string;
  openingLabel: string;
  settingsUrl: string;
  unsubscribeUrl: string;
  /** Mode d'essai (`TRIAL_END_EMAIL_MODE=internal`) : le message le dit en tête. */
  internal?: boolean;
};

export const TRIAL_END_EMAIL_TEMPLATE_VERSION = "trial_end_v2";

export function trialEndEmailPreview(endsOnLabel: string): string {
  return `Votre essai gratuit se termine le ${endsOnLabel}. Rien ne devient payant.`;
}

const e = escapeEmailHtml;

function list(items: readonly string[]): string {
  const rows = items
    .map((item) => `<li class="ej-body" style="margin:0 0 6px;">${e(item)}</li>`)
    .join("");
  return `<ul class="ej-body" style="margin:0 0 16px;padding-left:20px;font-size:16px;line-height:24px;">${rows}</ul>`;
}

/** Le message complet (cadre commun compris), en HTML. */
export function buildTrialEndEmailHtml({
  endsOnLabel,
  stays,
  needsAnalysis,
  dataText,
  noChargeText,
  openingUrl,
  openingLabel,
  settingsUrl,
  unsubscribeUrl,
  internal = false,
  title,
}: TrialEndEmailProps & { title?: string }): string {
  const heading = `Votre essai de l’offre Analyse se termine le ${endsOnLabel}`;
  const content = [
    internal
      ? emailPanel(
          emailParagraph(
            "Test interne : ce message d’exemple n’est envoyé qu’aux administrateurs.",
            {
              tone: "link",
              size: "caption",
              weight: 700,
            },
          ),
          "gold",
        )
      : "",
    emailEyebrow("Votre essai gratuit"),
    emailHeading(heading, 1),
    emailParagraph("Bonjour,"),
    emailParagraph(
      e(
        `Votre essai gratuit de l’offre Analyse se termine le ${endsOnLabel}. À cette date, votre compte revient à l’offre Découverte, gratuite et sans limite de durée. Ce message est le seul que nous vous envoyons à ce sujet.`,
      ),
    ),
    emailHeading("Ce qui reste gratuit", 2, { marginTop: 8 }),
    list(stays),
    emailHeading("Ce qui se ferme", 2, { marginTop: 8 }),
    emailParagraph(
      e(
        "Ces fonctions font partie de l’offre Analyse. Elles ne sont plus accessibles une fois l’essai terminé :",
      ),
      { marginBottom: 8 },
    ),
    list(needsAnalysis),
    emailPanel(
      emailParagraph(`<strong>${e(noChargeText)}</strong>`, { tone: "navy" }) +
        emailParagraph(e(dataText), { tone: "navy" }),
    ),
    emailParagraph(
      `${e("Si l’offre Analyse vous intéresse, vous pouvez demander à être prévenu de son ouverture :")} ${emailLink(openingUrl, e(openingLabel))}.`,
      { marginBottom: 0 },
    ),
  ].join("");

  return emailLayout({
    title: title ?? heading,
    preheader: trialEndEmailPreview(endsOnLabel),
    content,
    footer: {
      reason: `Vous recevez ce message parce que votre compte ${EMAIL_BRAND_NAME} est en essai gratuit. Une seule fois, pour cet essai.`,
      links: [
        { text: "Mon compte", href: settingsUrl },
        { text: "Ne plus recevoir ce message", href: unsubscribeUrl },
      ],
    },
  });
}

/** Aperçu `email dev` : le message tel qu'il part, dans un cadre. */
export function TrialEndEmail(props: TrialEndEmailProps) {
  return <div dangerouslySetInnerHTML={{ __html: buildTrialEndEmailHtml(props) }} />;
}

export async function renderTrialEndEmail(
  props: TrialEndEmailProps & { title?: string },
): Promise<string> {
  return buildTrialEndEmailHtml(props);
}

export default TrialEndEmail;
