import {
  emailEyebrow,
  emailHeading,
  emailLayout,
  emailLink,
  emailPanel,
  emailParagraph,
  escapeEmailHtml,
} from "../src/lib/email-layout";

/**
 * Email unique de prise en main, le lendemain de l'inscription : ce qu'est le déblocage compris dans le
 * compte gratuit, ce qu'il ouvre, qu'il est unique, quand il est rendu, où le retrouver, et un seul lien,
 * vers le catalogue. Aucun élément commercial. Le texte vient de `src/lib/onboarding-email.ts` (qui
 * reprend les textes du déblocage de `sale-unlocks.ts`) ; ici seulement la mise en forme, par le modèle
 * unique `emailLayout()` (`src/lib/email-layout.ts`), sans les liens vers le site du logo et de la ligne
 * de marque (`siteLinks: false`) : le catalogue reste le seul lien vers une page d'Immojudis.
 */
export type OnboardingEmailProps = {
  heading: string;
  intro: string;
  sections: ReadonlyArray<{ title: string; paragraphs: readonly string[] }>;
  /** Phrase qui précède le lien du catalogue. */
  catalogueText: string;
  catalogueLabel: string;
  catalogueUrl: string;
  /** Raison d'envoi du pied (« Message unique de prise en main… »). */
  reason: string;
  unsubscribeLabel: string;
  unsubscribeUrl: string;
  preheader: string;
  /** Mode d'essai (`ONBOARDING_EMAIL_MODE=internal`) : le message le dit en tête. */
  internalNotice?: string | null;
  title: string;
};

const e = escapeEmailHtml;

/** Le message complet (cadre commun compris), en HTML. */
export function buildOnboardingEmailHtml({
  heading,
  intro,
  sections,
  catalogueText,
  catalogueLabel,
  catalogueUrl,
  reason,
  unsubscribeLabel,
  unsubscribeUrl,
  preheader,
  internalNotice = null,
  title,
}: OnboardingEmailProps): string {
  const content = [
    internalNotice
      ? emailPanel(
          emailParagraph(e(internalNotice), { tone: "link", size: "caption", weight: 700 }),
          "gold",
        )
      : "",
    emailEyebrow("Prise en main"),
    emailHeading(heading, 1),
    emailParagraph("Bonjour,"),
    emailParagraph(e(intro)),
    ...sections.flatMap((section) => [
      emailHeading(section.title, 2, { marginTop: 8 }),
      ...section.paragraphs.map((paragraph) => emailParagraph(e(paragraph))),
    ]),
    emailParagraph(`${e(catalogueText)} ${emailLink(catalogueUrl, e(catalogueLabel))}.`, {
      marginBottom: 0,
    }),
  ].join("");

  return emailLayout({
    title,
    preheader,
    content,
    siteLinks: false,
    footer: {
      noReply: true,
      reason,
      links: [{ text: unsubscribeLabel, href: unsubscribeUrl }],
    },
  });
}

/** Aperçu `email dev` : le message tel qu'il part, dans un cadre. */
export function OnboardingEmail(props: OnboardingEmailProps) {
  return <div dangerouslySetInnerHTML={{ __html: buildOnboardingEmailHtml(props) }} />;
}

export default OnboardingEmail;
