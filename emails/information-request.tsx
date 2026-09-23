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

export type InformationRequestEmailProps = {
  subject: string;
  bodyText: string;
  replyTo: string;
  caseReference: string;
  appUrl?: string;
};

export const INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION = "information_request_v2";

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
};

export function InformationRequestEmail({
  subject,
  bodyText,
  replyTo,
  caseReference,
  appUrl = "https://immojudis.com",
}: InformationRequestEmailProps) {
  const blocks = parseBodyBlocks(bodyText);
  const replyHref = `mailto:${replyTo}`;

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
              <BodyBlockView key={`${block.kind}-${blockIndex}`} block={block} />
            ))}
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
        lines.every((line) =>
          /^(Référence|Audience annoncée|Date annoncée|Mise à prix annoncée)\s*:/i.test(line),
        )
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
