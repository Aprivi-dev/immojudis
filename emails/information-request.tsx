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
import {
  buildInformationAgentAccountUrl,
  INFORMATION_AGENT_ACCOUNT_INVITATION_CTA,
  INFORMATION_AGENT_ACCOUNT_INVITATION_DESCRIPTION,
  INFORMATION_AGENT_ACCOUNT_INVITATION_EYEBROW,
  INFORMATION_AGENT_ACCOUNT_INVITATION_HEADING,
} from "../src/lib/information-agent-email-template";

export type InformationRequestEmailProps = {
  subject: string;
  bodyText: string;
  replyTo: string;
  caseReference: string;
  appUrl?: string;
  accountUrl?: string;
  contributionUrl?: string;
};

export const INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION = "information_request_v4";

type BodyBlock =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "questions"; lines: string[] }
  | { kind: "sale"; lines: string[] }
  | { kind: "account"; lines: string[] };

const BRAND = {
  ink: "#172036",
  muted: "#667085",
  gold: "#A6792B",
  goldSoft: "#F6EEDC",
  line: "#E7E1D6",
  paper: "#FFFFFF",
  canvas: "#F5F2EB",
};

export function InformationRequestEmail({
  subject,
  bodyText,
  replyTo,
  caseReference,
  appUrl = "https://immojudis.com",
  accountUrl,
  contributionUrl,
}: InformationRequestEmailProps) {
  const blocks = parseBodyBlocks(bodyText);
  const replyHref = `mailto:${replyTo}`;
  const professionalSignupUrl = buildInformationAgentAccountUrl({ appUrl, accountUrl });
  const hasAccountInvitation = blocks.some(
    (block) =>
      block.kind === "account" &&
      block.lines.includes(
        `${INFORMATION_AGENT_ACCOUNT_INVITATION_CTA} : ${professionalSignupUrl}`,
      ),
  );

  return (
    <Html lang="fr">
      <Head />
      <Preview>{`Informations sur une vente judiciaire — ${subject}`}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.topBar} />
          <Section style={styles.header}>
            <Text style={styles.wordmark}>IMMOJUDIS</Text>
            <Text style={styles.tagline}>Analyse des ventes immobilières judiciaires</Text>
          </Section>

          <Section style={styles.content}>
            <Text style={styles.eyebrow}>VÉRIFICATION D’UNE ANNONCE</Text>
            <Heading as="h1" style={styles.heading}>
              Informations sur une vente judiciaire
            </Heading>
            <Text style={styles.reference}>Référence de suivi : {caseReference}</Text>

            <Hr style={styles.hr} />

            {blocks.map((block, blockIndex) => (
              <BodyBlockView
                key={`${block.kind}-${blockIndex}`}
                block={block}
                accountUrl={professionalSignupUrl}
              />
            ))}
            {contributionUrl ? (
              <Section style={styles.salePanel}>
                <Text style={styles.paragraph}>
                  Vous pouvez aussi déposer vos pièces dans notre espace privé, sans créer de
                  compte.
                </Text>
                <Text style={styles.paragraph}>
                  <Link href={contributionUrl}>Ouvrir le dépôt sécurisé du dossier</Link>
                </Text>
                <Text style={styles.footerText}>
                  Le dépôt reste soumis à une vérification avant toute publication.
                </Text>
              </Section>
            ) : null}
            {!hasAccountInvitation ? (
              <AccountInvitationPanel accountUrl={professionalSignupUrl} />
            ) : null}
          </Section>

          <Section style={styles.footer}>
            <Text style={styles.footerBrand}>ImmoJudis</Text>
            <Text style={styles.footerText}>
              Service indépendant d’aide à l’analyse des ventes immobilières judiciaires
            </Text>
            <Text style={styles.footerText}>
              <Link href={appUrl} style={styles.footerLink}>
                immojudis.com
              </Link>
              {" · "}Référence {caseReference}
            </Text>
            <Text style={styles.footerText}>
              Adresse de réponse : <Link href={replyHref}>{replyTo}</Link>
            </Text>
            <Text style={styles.footerLegal}>
              ImmoJudis n’agit pas au nom d’un tribunal. Une IA aide à lire et classer les réponses
              ; notre équipe vérifie les informations avant toute mise à jour de la fiche.
              <br />
              Merci de ne transmettre que des pièces que vous êtes autorisé à partager.
              <br />
              Si vous ne souhaitez plus être contacté par ImmoJudis, indiquez-le simplement en
              réponse.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export async function renderInformationRequestEmail(
  props: InformationRequestEmailProps,
): Promise<{ html: string; text: string }> {
  const email = <InformationRequestEmail {...props} />;
  const [html, renderedText] = await Promise.all([
    render(email, { pretty: false }),
    render(email, { plainText: true }),
  ]);
  return {
    html,
    text: renderedText,
  };
}

function BodyBlockView({ block, accountUrl }: { block: BodyBlock; accountUrl: string }) {
  if (block.kind === "account") {
    return <AccountInvitationPanel accountUrl={accountUrl} />;
  }

  if (block.kind === "questions") {
    return (
      <Section style={styles.questionsPanel}>
        {block.lines.map((line, index) => (
          <Text key={`${line}-${index}`} style={styles.questionItem}>
            {`• ${line.replace(/^[-•]\s*/, "")}`}
          </Text>
        ))}
      </Section>
    );
  }

  if (block.kind === "sale") {
    return (
      <Section style={styles.salePanel}>
        {block.lines.map((line, index) => {
          const separatorIndex = line.indexOf(":");
          const label = separatorIndex >= 0 ? line.slice(0, separatorIndex) : "Information";
          const value = separatorIndex >= 0 ? line.slice(separatorIndex + 1).trim() : line;
          return (
            <Text key={`${line}-${index}`} style={styles.saleRow}>
              <span style={styles.saleLabel}>{label}</span>
              <br />
              <span style={styles.saleValue}>{value}</span>
            </Text>
          );
        })}
      </Section>
    );
  }

  return (
    <Text style={styles.paragraph}>
      {block.lines.map((line, index) => (
        <React.Fragment key={`${line}-${index}`}>
          {index > 0 ? <br /> : null}
          {line}
        </React.Fragment>
      ))}
    </Text>
  );
}

function parseBodyBlocks(bodyText: string): BodyBlock[] {
  return bodyText
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    )
    .filter((lines) => lines.length > 0)
    .map((lines) => {
      if (
        lines[0] === INFORMATION_AGENT_ACCOUNT_INVITATION_EYEBROW &&
        lines[1] === INFORMATION_AGENT_ACCOUNT_INVITATION_HEADING &&
        lines[2] === INFORMATION_AGENT_ACCOUNT_INVITATION_DESCRIPTION &&
        lines[3]?.startsWith(`${INFORMATION_AGENT_ACCOUNT_INVITATION_CTA} : `)
      ) {
        return { kind: "account" as const, lines };
      }
      if (lines.every((line) => /^[-•]\s+/.test(line))) {
        return { kind: "questions" as const, lines };
      }
      if (
        lines.every((line) =>
          /^(Référence|Audience annoncée|Date annoncée|Mise à prix annoncée)\s*:/i.test(line),
        )
      ) {
        return { kind: "sale" as const, lines };
      }
      return { kind: "paragraph" as const, lines };
    });
}

function AccountInvitationPanel({ accountUrl }: { accountUrl: string }) {
  return (
    <Section style={styles.professionalPanel}>
      <Text style={styles.professionalEyebrow}>{INFORMATION_AGENT_ACCOUNT_INVITATION_EYEBROW}</Text>
      <Text style={styles.professionalHeading}>{INFORMATION_AGENT_ACCOUNT_INVITATION_HEADING}</Text>
      <Text style={styles.paragraph}>{INFORMATION_AGENT_ACCOUNT_INVITATION_DESCRIPTION}</Text>
      <Text style={styles.professionalCta}>
        <Link href={accountUrl} style={styles.professionalLink}>
          {INFORMATION_AGENT_ACCOUNT_INVITATION_CTA}
        </Link>
      </Text>
    </Section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  body: {
    margin: 0,
    padding: "24px 10px",
    backgroundColor: BRAND.canvas,
    color: BRAND.ink,
    fontFamily: "Arial, Helvetica, sans-serif",
  },
  container: {
    width: "100%",
    maxWidth: "640px",
    margin: "0 auto",
    backgroundColor: BRAND.paper,
    border: `1px solid ${BRAND.line}`,
    borderRadius: "14px",
    overflow: "hidden",
  },
  topBar: { height: "6px", backgroundColor: BRAND.gold },
  header: { padding: "18px 28px 14px", borderBottom: `1px solid ${BRAND.line}` },
  wordmark: {
    margin: 0,
    color: BRAND.ink,
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: "23px",
    fontWeight: 700,
    letterSpacing: "0.08em",
  },
  tagline: { margin: "3px 0 8px", color: BRAND.muted, fontSize: "12px", lineHeight: "17px" },
  content: { padding: "22px 28px 24px" },
  eyebrow: {
    margin: "0 0 6px",
    color: BRAND.gold,
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.1em",
  },
  heading: {
    margin: "0 0 8px",
    color: BRAND.ink,
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: "25px",
    lineHeight: "31px",
    fontWeight: 600,
  },
  reference: {
    display: "inline-block",
    margin: 0,
    padding: "5px 8px",
    color: BRAND.ink,
    backgroundColor: BRAND.goldSoft,
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 700,
  },
  hr: { margin: "18px 0", borderColor: BRAND.line },
  paragraph: { margin: "0 0 14px", color: "#303A50", fontSize: "15px", lineHeight: "21px" },
  salePanel: {
    margin: "2px 0 16px",
    padding: "12px 14px 1px",
    backgroundColor: "#F9F8F5",
    border: `1px solid ${BRAND.line}`,
    borderRadius: "10px",
  },
  saleRow: { margin: "0 0 11px", color: BRAND.ink, fontSize: "14px", lineHeight: "20px" },
  saleLabel: { color: BRAND.muted, fontSize: "11px", fontWeight: 700, textTransform: "uppercase" },
  saleValue: { color: BRAND.ink, fontSize: "14px", fontWeight: 700 },
  questionsPanel: {
    margin: "0 0 16px",
    padding: "4px 14px",
    borderLeft: `3px solid ${BRAND.gold}`,
    backgroundColor: "#FCFBF8",
  },
  professionalPanel: {
    margin: "6px 0 4px",
    padding: "14px 14px 4px",
    backgroundColor: BRAND.goldSoft,
    border: "1px solid #D9C08D",
    borderRadius: "10px",
  },
  professionalEyebrow: {
    margin: "0 0 5px",
    color: BRAND.gold,
    fontSize: "10px",
    fontWeight: 700,
    letterSpacing: "0.1em",
  },
  professionalHeading: {
    margin: "0 0 6px",
    color: BRAND.ink,
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: "18px",
    lineHeight: "23px",
    fontWeight: 600,
  },
  professionalCta: { margin: "0 0 10px", fontSize: "14px", lineHeight: "20px" },
  professionalLink: { color: BRAND.ink, fontWeight: 700, textDecoration: "underline" },
  questionItem: { margin: "7px 0", color: "#303A50", fontSize: "14px", lineHeight: "20px" },
  footer: {
    padding: "18px 28px 22px",
    backgroundColor: "#F9F8F5",
    borderTop: `1px solid ${BRAND.line}`,
    textAlign: "center",
  },
  footerBrand: {
    margin: "0 0 4px",
    color: BRAND.ink,
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: "16px",
    fontWeight: 700,
  },
  footerText: { margin: "2px 0", color: BRAND.muted, fontSize: "11px", lineHeight: "17px" },
  footerLink: { color: BRAND.ink, fontWeight: 700, textDecoration: "none" },
  footerLegal: { margin: "14px 0 0", color: "#8B909C", fontSize: "10px", lineHeight: "16px" },
};

export default InformationRequestEmail;
