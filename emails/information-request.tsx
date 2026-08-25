import * as React from "react";
import {
  Body,
  Button,
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

export type InformationRequestEmailProps = {
  subject: string;
  bodyText: string;
  replyTo: string;
  caseReference: string;
  appUrl?: string;
};

export const INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION = "information_request_v1";

type BodyBlock =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "questions"; lines: string[] }
  | { kind: "sale"; lines: string[] };

const BRAND = {
  ink: "#172036",
  muted: "#667085",
  gold: "#A6792B",
  goldSoft: "#F6EEDC",
  line: "#E7E1D6",
  paper: "#FFFFFF",
  canvas: "#F5F2EB",
  green: "#17745B",
  greenSoft: "#E8F5F0",
};

export function InformationRequestEmail({
  subject,
  bodyText,
  replyTo,
  caseReference,
  appUrl = "https://immojudis.com",
}: InformationRequestEmailProps) {
  const blocks = parseBodyBlocks(bodyText);
  const replyHref = `mailto:${replyTo}?subject=${encodeURIComponent(`Re: ${subject}`)}`;

  return (
    <Html lang="fr">
      <Head />
      <Preview>{`${subject} — demande transmise via ImmoJudis`}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.topBar} />
          <Section style={styles.header}>
            <Text style={styles.wordmark}>IMMOJUDIS</Text>
            <Text style={styles.tagline}>Analyse des ventes immobilières judiciaires</Text>
            <Text style={styles.validationBadge}>✓ Demande validée avant envoi</Text>
          </Section>

          <Section style={styles.content}>
            <Text style={styles.eyebrow}>DEMANDE DOCUMENTAIRE SÉCURISÉE</Text>
            <Heading as="h1" style={styles.heading}>
              Demande d’informations relative à une vente immobilière
            </Heading>
            <Text style={styles.reference}>Référence de suivi : {caseReference}</Text>

            <Hr style={styles.hr} />

            {blocks.map((block, blockIndex) => (
              <BodyBlockView key={`${block.kind}-${blockIndex}`} block={block} />
            ))}

            <Section style={styles.replyPanel}>
              <Text style={styles.replyTitle}>Vous pouvez répondre directement à cet email</Text>
              <Text style={styles.replyCopy}>
                Les PDF et photographies peuvent être joints à votre réponse. Ils seront conservés
                dans un espace privé, analysés avec traçabilité puis contrôlés avant toute
                intégration aux données ImmoJudis.
              </Text>
              <Button href={replyHref} style={styles.button}>
                Répondre à la demande
              </Button>
              <Text style={styles.replyAddress}>
                Adresse de réponse :{" "}
                <Link href={replyHref} style={styles.inlineLink}>
                  {replyTo}
                </Link>
              </Text>
            </Section>

            <Section style={styles.trustPanel}>
              <Text style={styles.trustTitle}>Un traitement responsable et transparent</Text>
              <Text style={styles.trustItem}>
                <span style={styles.trustBullet}>01</span>
                ImmoJudis est un service indépendant d’analyse des ventes immobilières judiciaires.
                Ce message n’émane ni du tribunal ni d’une administration.
              </Text>
              <Text style={styles.trustItem}>
                <span style={styles.trustBullet}>02</span>
                L’adresse personnelle de l’utilisateur à l’origine de la demande n’est pas transmise
                au destinataire.
              </Text>
              <Text style={styles.trustItemLast}>
                <span style={styles.trustBullet}>03</span>
                L’IA assiste la lecture des réponses ; les informations proposées restent soumises à
                contrôle avant de modifier une annonce, une estimation ou une description.
              </Text>
            </Section>
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
            <Text style={styles.footerLegal}>
              Message préparé avec l’assistance d’un système d’IA et envoyé après validation
              explicite d’un utilisateur ImmoJudis. Merci de ne transmettre que les documents que
              vous êtes autorisé à communiquer.
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
  return { html, text: renderedText };
}

function BodyBlockView({ block }: { block: BodyBlock }) {
  if (block.kind === "questions") {
    return (
      <Section style={styles.questionsPanel}>
        {block.lines.map((line, index) => (
          <Text key={`${line}-${index}`} style={styles.questionItem}>
            <span style={styles.questionNumber}>{String(index + 1).padStart(2, "0")}</span>
            {line.replace(/^[-•]\s*/, "")}
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
      if (lines.every((line) => /^[-•]\s+/.test(line))) {
        return { kind: "questions" as const, lines };
      }
      if (
        lines.length >= 2 &&
        lines.every((line) => /^(Référence|Date annoncée|Mise à prix annoncée)\s*:/i.test(line))
      ) {
        return { kind: "sale" as const, lines };
      }
      return { kind: "paragraph" as const, lines };
    });
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
  header: { padding: "24px 34px 20px", borderBottom: `1px solid ${BRAND.line}` },
  wordmark: {
    margin: 0,
    color: BRAND.ink,
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: "25px",
    fontWeight: 700,
    letterSpacing: "0.08em",
  },
  tagline: { margin: "4px 0 14px", color: BRAND.muted, fontSize: "12px", lineHeight: "18px" },
  validationBadge: {
    display: "inline-block",
    margin: 0,
    padding: "6px 10px",
    color: BRAND.green,
    backgroundColor: BRAND.greenSoft,
    borderRadius: "999px",
    fontSize: "11px",
    fontWeight: 700,
  },
  content: { padding: "30px 34px 34px" },
  eyebrow: {
    margin: "0 0 9px",
    color: BRAND.gold,
    fontSize: "11px",
    fontWeight: 700,
    letterSpacing: "0.1em",
  },
  heading: {
    margin: "0 0 12px",
    color: BRAND.ink,
    fontFamily: "Georgia, 'Times New Roman', serif",
    fontSize: "28px",
    lineHeight: "35px",
    fontWeight: 600,
  },
  reference: {
    display: "inline-block",
    margin: 0,
    padding: "7px 10px",
    color: BRAND.ink,
    backgroundColor: BRAND.goldSoft,
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 700,
  },
  hr: { margin: "26px 0", borderColor: BRAND.line },
  paragraph: { margin: "0 0 18px", color: "#303A50", fontSize: "15px", lineHeight: "24px" },
  salePanel: {
    margin: "4px 0 22px",
    padding: "16px 18px 2px",
    backgroundColor: "#F9F8F5",
    border: `1px solid ${BRAND.line}`,
    borderRadius: "10px",
  },
  saleRow: { margin: "0 0 14px", color: BRAND.ink, fontSize: "14px", lineHeight: "20px" },
  saleLabel: { color: BRAND.muted, fontSize: "11px", fontWeight: 700, textTransform: "uppercase" },
  saleValue: { color: BRAND.ink, fontSize: "14px", fontWeight: 700 },
  questionsPanel: {
    margin: "0 0 22px",
    padding: "6px 18px",
    borderLeft: `3px solid ${BRAND.gold}`,
    backgroundColor: "#FCFBF8",
  },
  questionItem: { margin: "10px 0", color: "#303A50", fontSize: "14px", lineHeight: "22px" },
  questionNumber: { marginRight: "10px", color: BRAND.gold, fontSize: "11px", fontWeight: 700 },
  replyPanel: {
    margin: "26px 0 20px",
    padding: "22px",
    backgroundColor: BRAND.ink,
    borderRadius: "11px",
  },
  replyTitle: { margin: "0 0 8px", color: "#FFFFFF", fontSize: "17px", fontWeight: 700 },
  replyCopy: { margin: "0 0 18px", color: "#D7DDEA", fontSize: "13px", lineHeight: "20px" },
  button: {
    display: "inline-block",
    padding: "12px 18px",
    color: "#FFFFFF",
    backgroundColor: BRAND.gold,
    borderRadius: "7px",
    fontSize: "14px",
    fontWeight: 700,
    textDecoration: "none",
  },
  replyAddress: { margin: "14px 0 0", color: "#AEB8CB", fontSize: "11px", lineHeight: "17px" },
  inlineLink: { color: "#FFFFFF", textDecoration: "underline" },
  trustPanel: {
    padding: "20px 20px 8px",
    backgroundColor: "#F9F8F5",
    border: `1px solid ${BRAND.line}`,
    borderRadius: "10px",
  },
  trustTitle: { margin: "0 0 14px", color: BRAND.ink, fontSize: "14px", fontWeight: 700 },
  trustItem: {
    margin: "0 0 12px",
    paddingBottom: "12px",
    color: BRAND.muted,
    borderBottom: `1px solid ${BRAND.line}`,
    fontSize: "12px",
    lineHeight: "19px",
  },
  trustItemLast: { margin: "0 0 12px", color: BRAND.muted, fontSize: "12px", lineHeight: "19px" },
  trustBullet: { marginRight: "8px", color: BRAND.gold, fontSize: "10px", fontWeight: 700 },
  footer: {
    padding: "24px 34px 28px",
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
