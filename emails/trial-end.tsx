import * as React from "react";
import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
  render,
} from "react-email";
import { EMAIL_BRAND_NAME, EMAIL_COLORS, EMAIL_FONT_STACK } from "../src/lib/email-brand";

/**
 * Email unique de fin d'essai gratuit (J+5), sans pression : ce qui reste gratuit, ce qui se ferme,
 * le fait que rien ne devient payant, et un seul lien (« Être prévenu de l'ouverture »). Pas de compte
 * à rebours, pas de réduction, pas d'appel à s'abonner. Le texte vient de `src/lib/trial-end-email.ts`
 * (et des listes de `launch-offer-end-lists.ts`, les mêmes que le bloc de /compte) ; ici seulement la
 * mise en forme.
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

export const TRIAL_END_EMAIL_TEMPLATE_VERSION = "trial_end_v1";

export function trialEndEmailPreview(endsOnLabel: string): string {
  return `Votre essai gratuit se termine le ${endsOnLabel}. Rien ne devient payant : votre compte reste gratuit.`;
}

export function TrialEndEmail({
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
}: TrialEndEmailProps) {
  return (
    <Html lang="fr">
      <Head />
      <Preview>{trialEndEmailPreview(endsOnLabel)}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.topBar} />
          <Section style={styles.header}>
            <Text style={styles.wordmark}>{EMAIL_BRAND_NAME}</Text>
          </Section>

          <Section style={styles.content}>
            {internal ? (
              <Text style={styles.internal}>
                Test interne : ce message d’exemple n’est envoyé qu’aux administrateurs.
              </Text>
            ) : null}
            <Text style={styles.eyebrow}>VOTRE ESSAI GRATUIT</Text>
            <Heading as="h1" style={styles.heading}>
              Votre essai de l’offre Analyse se termine le {endsOnLabel}
            </Heading>
            <Text style={styles.paragraph}>Bonjour,</Text>
            <Text style={styles.paragraph}>
              Votre essai gratuit de l’offre Analyse se termine le {endsOnLabel}. À cette date,
              votre compte revient à l’offre Découverte, gratuite et sans limite de durée. Ce
              message est le seul que nous vous envoyons à ce sujet.
            </Text>

            <Heading as="h2" style={styles.subheading}>
              Ce qui reste gratuit
            </Heading>
            <ul style={styles.list}>
              {stays.map((item) => (
                <li key={item} style={styles.item}>
                  {item}
                </li>
              ))}
            </ul>

            <Heading as="h2" style={styles.subheading}>
              Ce qui se ferme
            </Heading>
            <Text style={styles.paragraph}>
              Ces fonctions font partie de l’offre Analyse. Elles ne sont plus accessibles une fois
              l’essai terminé :
            </Text>
            <ul style={styles.list}>
              {needsAnalysis.map((item) => (
                <li key={item} style={styles.item}>
                  {item}
                </li>
              ))}
            </ul>

            <Section style={styles.reassurance}>
              <Text style={styles.reassuranceText}>
                <strong>{noChargeText}</strong>
              </Text>
              <Text style={styles.reassuranceText}>{dataText}</Text>
            </Section>

            <Text style={styles.paragraph}>
              Si l’offre Analyse vous intéresse, vous pouvez demander à être prévenu de son
              ouverture :{" "}
              <Link href={openingUrl} style={styles.link}>
                {openingLabel}
              </Link>
              .
            </Text>
            <Hr style={styles.hr} />
          </Section>

          <Section style={styles.footer}>
            <Text style={styles.footerText}>
              Vous recevez ce message parce que votre compte {EMAIL_BRAND_NAME} est en essai
              gratuit. Une seule fois, pour cet essai.
            </Text>
            <Text style={styles.footerText}>
              <Link href={settingsUrl} style={styles.footerLink}>
                Mon compte
              </Link>{" "}
              ·{" "}
              <Link href={unsubscribeUrl} style={styles.footerLink}>
                Ne plus recevoir ce message
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export async function renderTrialEndEmail(props: TrialEndEmailProps): Promise<string> {
  return render(<TrialEndEmail {...props} />, { pretty: false });
}

const styles: Record<string, React.CSSProperties> = {
  body: {
    margin: 0,
    padding: "24px 10px",
    backgroundColor: EMAIL_COLORS.surface,
    color: EMAIL_COLORS.navy,
    fontFamily: EMAIL_FONT_STACK,
  },
  container: {
    width: "100%",
    maxWidth: "620px",
    margin: "0 auto",
    backgroundColor: EMAIL_COLORS.white,
    border: `1px solid ${EMAIL_COLORS.lineWarm}`,
    borderRadius: "14px",
    overflow: "hidden",
  },
  topBar: { height: "6px", backgroundColor: EMAIL_COLORS.gold },
  header: { padding: "18px 28px 14px", borderBottom: `1px solid ${EMAIL_COLORS.lineWarm}` },
  wordmark: {
    margin: 0,
    color: EMAIL_COLORS.navy,
    fontFamily: EMAIL_FONT_STACK,
    fontSize: "24px",
    fontWeight: 700,
  },
  content: { padding: "22px 28px 12px" },
  internal: {
    margin: "0 0 14px",
    padding: "8px 10px",
    backgroundColor: EMAIL_COLORS.cream,
    color: EMAIL_COLORS.goldText,
    borderRadius: "6px",
    fontSize: "13px",
    fontWeight: 700,
  },
  eyebrow: {
    margin: "0 0 6px",
    color: EMAIL_COLORS.goldText,
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.1em",
  },
  heading: {
    margin: "0 0 14px",
    color: EMAIL_COLORS.navy,
    fontFamily: EMAIL_FONT_STACK,
    fontSize: "24px",
    lineHeight: "30px",
    fontWeight: 600,
  },
  subheading: {
    margin: "18px 0 8px",
    color: EMAIL_COLORS.navy,
    fontFamily: EMAIL_FONT_STACK,
    fontSize: "17px",
    lineHeight: "23px",
    fontWeight: 700,
  },
  paragraph: {
    margin: "0 0 12px",
    color: EMAIL_COLORS.inkStrong,
    fontSize: "15px",
    lineHeight: "22px",
  },
  list: { margin: "0 0 12px", paddingLeft: "20px" },
  item: { margin: "0 0 6px", color: EMAIL_COLORS.inkStrong, fontSize: "15px", lineHeight: "22px" },
  reassurance: {
    margin: "16px 0",
    padding: "12px 14px 2px",
    backgroundColor: EMAIL_COLORS.surfaceMuted,
    border: `1px solid ${EMAIL_COLORS.lineWarm}`,
    borderRadius: "8px",
  },
  reassuranceText: {
    margin: "0 0 10px",
    color: EMAIL_COLORS.navy,
    fontSize: "15px",
    lineHeight: "22px",
  },
  link: { color: EMAIL_COLORS.navy, fontWeight: 700, textDecoration: "underline" },
  hr: { margin: "16px 0 0", borderColor: EMAIL_COLORS.lineWarm },
  footer: { padding: "12px 28px 20px" },
  footerText: {
    margin: "0 0 6px",
    color: EMAIL_COLORS.inkSoft,
    fontSize: "12px",
    lineHeight: "18px",
  },
  footerLink: { color: EMAIL_COLORS.inkSoft, textDecoration: "underline" },
};
