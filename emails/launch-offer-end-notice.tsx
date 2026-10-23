import * as React from "react";
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Section,
  Text,
  render,
} from "react-email";
import { EMAIL_BRAND_NAME, EMAIL_COLORS } from "../src/lib/email-brand";
import {
  LAUNCH_OFFER_END_NEEDS_ANALYSIS,
  LAUNCH_OFFER_END_STAYS,
} from "../src/lib/launch-offer-end-lists";
import { LAUNCH_OFFER_DATA_TEXT, LAUNCH_OFFER_LABEL } from "../src/lib/launch-offer";

/**
 * Préavis de fin de l'offre de lancement (n° 74). Ton factuel : la date annoncée, ce qui reste gratuit,
 * ce qui demandera l'offre Analyse, ce que deviennent les données. Aucun prix, aucun compte à rebours,
 * aucune incitation à s'abonner, aucune promesse que les textes publics (`src/lib/launch-offer.ts`,
 * CGV art. 13) ne font déjà : la phrase sur les données est la leur, mot pour mot.
 */
export type LaunchOfferEndNoticeProps = {
  /** La date de fin annoncée, déjà écrite : « 30 novembre 2026 ». */
  endsOnLabel: string;
  /** Page du compte (origine du site + /compte). */
  accountUrl: string;
  /** Lien de désinscription signé de ce préavis. */
  unsubscribeUrl: string;
};

export const LAUNCH_OFFER_END_NOTICE_TEMPLATE_VERSION = "launch_offer_end_notice_v1";

export function launchOfferEndNoticeSubject(endsOnLabel: string): string {
  return `Immojudis : fin de l’offre de lancement prévue le ${endsOnLabel}`;
}

const INTRO = (endsOnLabel: string) =>
  `Votre compte gratuit bénéficie, depuis l’offre de lancement, des avantages de l’offre Analyse. Nous prévoyons de mettre fin à cette offre le ${endsOnLabel}. Ce message vous prévient à l’avance.`;
const AFTER = "À cette date, votre compte revient à l’offre Découverte.";
const REASON =
  "Vous recevez ce message parce que votre compte bénéficie de l’offre de lancement. Votre compte n’est pas modifié si vous ne souhaitez plus le recevoir.";

export function LaunchOfferEndNoticeEmail({
  endsOnLabel,
  accountUrl,
  unsubscribeUrl,
}: LaunchOfferEndNoticeProps) {
  return (
    <Html lang="fr">
      <Head />
      <Preview>{`L’offre de lancement est prévue pour se terminer le ${endsOnLabel}.`}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.topBar} />
          <Section style={styles.header}>
            <Text style={styles.wordmark}>{EMAIL_BRAND_NAME}</Text>
          </Section>
          <Section style={styles.content}>
            <Text style={styles.eyebrow}>{LAUNCH_OFFER_LABEL.toUpperCase()}</Text>
            <Heading as="h1" style={styles.heading}>
              Fin de l’offre de lancement prévue le {endsOnLabel}
            </Heading>
            <Text style={styles.paragraph}>Bonjour,</Text>
            <Text style={styles.paragraph}>{INTRO(endsOnLabel)}</Text>
            <Text style={styles.paragraph}>{AFTER}</Text>
            <Heading as="h2" style={styles.subheading}>
              Ce qui reste gratuit
            </Heading>
            <Section style={styles.panel}>
              {LAUNCH_OFFER_END_STAYS.map((item) => (
                <Text key={item} style={styles.item}>{`• ${item}`}</Text>
              ))}
            </Section>
            <Heading as="h2" style={styles.subheading}>
              Ce qui demandera l’offre Analyse
            </Heading>
            <Section style={styles.panel}>
              {LAUNCH_OFFER_END_NEEDS_ANALYSIS.map((item) => (
                <Text key={item} style={styles.item}>{`• ${item}`}</Text>
              ))}
            </Section>
            <Text style={styles.paragraph}>{LAUNCH_OFFER_DATA_TEXT}</Text>
            <Text style={styles.paragraph}>
              Le détail figure dans votre compte :{" "}
              <Link href={accountUrl} style={styles.link}>
                {accountUrl}
              </Link>
            </Text>
          </Section>
          <Section style={styles.footer}>
            <Text style={styles.footerText}>{REASON}</Text>
            <Text style={styles.footerText}>
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

export async function renderLaunchOfferEndNoticeEmail(
  props: LaunchOfferEndNoticeProps,
): Promise<{ html: string; text: string }> {
  const email = <LaunchOfferEndNoticeEmail {...props} />;
  const [html, text] = await Promise.all([
    render(email, { pretty: false }),
    render(email, { plainText: true }),
  ]);
  return { html, text };
}

const styles: Record<string, React.CSSProperties> = {
  body: {
    margin: 0,
    padding: "24px 10px",
    backgroundColor: EMAIL_COLORS.surface,
    color: EMAIL_COLORS.navy,
    fontFamily: "Arial, Helvetica, sans-serif",
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
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: "24px",
    fontWeight: 700,
  },
  content: { padding: "22px 28px 24px" },
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
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: "24px",
    lineHeight: "30px",
    fontWeight: 600,
  },
  subheading: { margin: "16px 0 6px", color: EMAIL_COLORS.navy, fontSize: "15px" },
  paragraph: {
    margin: "0 0 14px",
    color: EMAIL_COLORS.inkStrong,
    fontSize: "15px",
    lineHeight: "21px",
  },
  panel: {
    margin: "0 0 12px",
    padding: "4px 14px",
    borderLeft: `3px solid ${EMAIL_COLORS.gold}`,
    backgroundColor: EMAIL_COLORS.surfaceMuted,
  },
  item: { margin: "7px 0", color: EMAIL_COLORS.inkStrong, fontSize: "14px", lineHeight: "20px" },
  link: { color: EMAIL_COLORS.navy, fontWeight: 700, textDecoration: "underline" },
  footer: {
    padding: "16px 28px 20px",
    backgroundColor: EMAIL_COLORS.surfaceMuted,
    borderTop: `1px solid ${EMAIL_COLORS.lineWarm}`,
  },
  footerText: {
    margin: "2px 0",
    color: EMAIL_COLORS.inkSoft,
    fontSize: "12px",
    lineHeight: "18px",
  },
  footerLink: { color: EMAIL_COLORS.inkSoft, textDecoration: "underline" },
};

export default LaunchOfferEndNoticeEmail;
