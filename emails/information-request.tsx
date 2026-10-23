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
import { EMAIL_BRAND_NAME, EMAIL_COLORS } from "../src/lib/email-brand";
import { containsInformationAgentAccountInvitation } from "../src/lib/information-agent-email-template";
import {
  INFORMATION_AGENT_CNIL_COMPLAINT_URL,
  informationAgentLegalFooterSections,
  type InformationAgentLegalFooter,
} from "../src/lib/information-agent-compliance";

export type InformationRequestEmailProps = {
  subject: string;
  bodyText: string;
  replyTo: string;
  caseReference: string;
  /** Origine du site, pour les liens absolus construits par l'appelant (non affichée dans le message). */
  appUrl?: string;
  contributionUrl?: string;
  /** GDPR art. 14 information and one-click objection link, mandatory for real sends. */
  legalFooter?: InformationAgentLegalFooter;
};

export const INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION = "information_request_v9";

type BodyBlock =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "questions"; lines: string[] }
  | { kind: "sale"; lines: string[] };

// Les jetons de la marque (`src/lib/email-brand.ts`), pas des hexadécimaux propres à ce gabarit.
const BRAND = {
  ink: EMAIL_COLORS.navy,
  body: EMAIL_COLORS.inkStrong,
  muted: EMAIL_COLORS.inkSoft,
  gold: EMAIL_COLORS.gold,
  goldText: EMAIL_COLORS.goldText,
  goldSoft: EMAIL_COLORS.cream,
  line: EMAIL_COLORS.lineWarm,
  paper: EMAIL_COLORS.white,
  canvas: EMAIL_COLORS.surface,
  panel: EMAIL_COLORS.surfaceMuted,
};

export function InformationRequestEmail({
  bodyText,
  replyTo,
  caseReference,
  contributionUrl,
  legalFooter,
}: InformationRequestEmailProps) {
  const blocks = parseBodyBlocks(bodyText);
  const replyHref = `mailto:${replyTo}`;
  // Après le premier paragraphe qui suit les questions (« Répondre est facultatif… »), sinon à la fin.
  const lastQuestions = blocks.map((block) => block.kind).lastIndexOf("questions");
  const depositIndex =
    lastQuestions >= 0 ? Math.min(lastQuestions + 1, blocks.length - 1) : blocks.length - 1;
  return (
    <Html lang="fr">
      <Head />
      <Preview>{informationRequestPreviewText(blocks)}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.topBar} />
          <Section style={styles.header}>
            <Text style={styles.wordmark}>{EMAIL_BRAND_NAME}</Text>
          </Section>

          <Section style={styles.content}>
            <Text style={styles.eyebrow}>VÉRIFICATION D’UNE ANNONCE</Text>
            <Heading as="h1" style={styles.heading}>
              Quelques points à vérifier sur une vente
            </Heading>
            <Text style={styles.reference}>Référence de suivi : {caseReference}</Text>
            {legalFooter ? (
              <Text style={styles.origin}>
                <strong>Pourquoi vous ?</strong> {legalFooter.addressOrigin}
              </Text>
            ) : null}

            <Hr style={styles.hr} />

            {blocks.map((block, blockIndex) => (
              <React.Fragment key={`${block.kind}-${blockIndex}`}>
                <BodyBlockView block={block} />
                {/* Le dépôt suit les questions : c'est là que le destinataire décide comment répondre. */}
                {contributionUrl && blockIndex === depositIndex ? (
                  <DepositPanel contributionUrl={contributionUrl} />
                ) : null}
              </React.Fragment>
            ))}
            {contributionUrl && depositIndex < 0 ? (
              <DepositPanel contributionUrl={contributionUrl} />
            ) : null}
          </Section>

          <Section style={styles.footer}>
            <Text style={styles.footerBrand}>{EMAIL_BRAND_NAME}</Text>
            <Text style={styles.footerText}>Référence {caseReference}</Text>
            <Text style={styles.footerText}>
              Adresse de réponse : <Link href={replyHref}>{replyTo}</Link>
            </Text>
            {legalFooter ? <LegalFooter footer={legalFooter} /> : null}
            <Text style={styles.footerLegal}>
              Immojudis n’agit pas au nom d’un tribunal. Une IA aide à lire et classer les réponses
              ; notre équipe vérifie les informations avant toute mise à jour de la fiche.
              <br />
              Merci de ne transmettre que des pièces que vous êtes autorisé à partager.
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

function DepositPanel({ contributionUrl }: { contributionUrl: string }) {
  let host: string;
  try {
    host = new URL(contributionUrl).host.replace(/^www\./, "");
  } catch {
    host = "";
  }
  return (
    <Section style={styles.salePanel}>
      <Text style={styles.paragraph}>
        Des pièces trop lourdes pour un email ? Déposez-les dans l’espace privé de ce dossier
        {host ? `, sur ${host}` : ""}. Aucun compte ni mot de passe ne vous sera demandé.
      </Text>
      <Text style={styles.paragraph}>
        <Link href={contributionUrl} style={styles.depositLink}>
          Déposer des pièces pour ce dossier
        </Link>
      </Text>
      <Text style={styles.footerText}>
        Ce lien est propre à ce dossier. Rien n’est publié sans vérification par notre équipe.
      </Text>
    </Section>
  );
}

function BodyBlockView({ block }: { block: BodyBlock }) {
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
          const label = separatorIndex >= 0 ? line.slice(0, separatorIndex).trim() : "Information";
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

/** Lignes du bloc « vente » : « Référence de l’annonce : … », « Audience annoncée, à confirmer : … ». */
const SALE_LINE =
  /^(Référence(?: de l[’']annonce)?|Audience annoncée|Date annoncée|Date de vente annoncée|Mise à prix annoncée)(?:, à confirmer)?\s*:/i;

/** Aperçu affiché par la messagerie sous l'objet : ce qu'on attend, et que c'est facultatif. */
function informationRequestPreviewText(blocks: readonly BodyBlock[]): string {
  const count = blocks
    .filter((block) => block.kind === "questions")
    .reduce((total, block) => total + block.lines.length, 0);
  const asked =
    count > 1
      ? `${count} points à vérifier sur cette vente`
      : count === 1
        ? "Un point à vérifier sur cette vente"
        : "Quelques points à vérifier sur cette vente";
  return `${asked}. Réponse facultative, par simple retour d’email.`;
}

function parseBodyBlocks(bodyText: string): BodyBlock[] {
  return (
    bodyText
      .replace(/\r\n?/g, "\n")
      .split(/\n\s*\n/)
      .map((block) =>
        block
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      )
      .filter((lines) => lines.length > 0)
      // Defence in depth: a legacy prospecting block is dropped even if it reached the body.
      .filter((lines) => !containsInformationAgentAccountInvitation(lines.join("\n")))
      .map((lines) => {
        if (lines.every((line) => /^[-•]\s+/.test(line))) {
          return { kind: "questions" as const, lines };
        }
        if (lines.every((line) => SALE_LINE.test(line))) {
          return { kind: "sale" as const, lines };
        }
        return { kind: "paragraph" as const, lines };
      })
  );
}

function LegalFooter({ footer }: { footer: InformationAgentLegalFooter }) {
  return (
    <>
      {informationAgentLegalFooterSections(footer).map((section) => (
        <Text
          key={section.label}
          style={section.label === "Opposition :" ? styles.footerObjection : styles.footerLegal}
        >
          <strong>{section.label}</strong> {section.text}
        </Text>
      ))}
      <Text style={styles.footerLegal}>
        <Link href={footer.optOutUrl} style={styles.footerLink}>
          Ne plus être contacté (un clic)
        </Link>
        {" · "}
        <Link href={footer.privacyUrl} style={styles.footerLink}>
          Politique de confidentialité et vos droits
        </Link>
        {" · "}
        <Link href={INFORMATION_AGENT_CNIL_COMPLAINT_URL} style={styles.footerLink}>
          Réclamation auprès de la CNIL
        </Link>
      </Text>
    </>
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
    fontSize: "24px",
    fontWeight: 700,
    letterSpacing: "0.01em",
  },
  content: { padding: "22px 28px 24px" },
  eyebrow: {
    margin: "0 0 6px",
    color: BRAND.goldText,
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
  origin: { margin: "12px 0 0", color: BRAND.body, fontSize: "13px", lineHeight: "19px" },
  depositLink: { color: BRAND.ink, fontWeight: 700, textDecoration: "underline" },
  paragraph: { margin: "0 0 14px", color: BRAND.body, fontSize: "15px", lineHeight: "21px" },
  salePanel: {
    margin: "2px 0 16px",
    padding: "12px 14px 1px",
    backgroundColor: BRAND.panel,
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
    backgroundColor: BRAND.panel,
  },
  questionItem: { margin: "7px 0", color: BRAND.body, fontSize: "14px", lineHeight: "20px" },
  footer: {
    padding: "18px 28px 22px",
    backgroundColor: BRAND.panel,
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
  footerText: { margin: "2px 0", color: BRAND.muted, fontSize: "12px", lineHeight: "18px" },
  footerLink: { color: BRAND.ink, fontWeight: 700, textDecoration: "none" },
  footerLegal: {
    margin: "14px 0 0",
    color: BRAND.muted,
    fontSize: "12px",
    lineHeight: "18px",
    textAlign: "left",
  },
  // Droit d'opposition : bloc distinct, lisible au premier regard (art. 21(4) RGPD).
  footerObjection: {
    margin: "14px 0 0",
    padding: "10px 12px",
    color: BRAND.ink,
    backgroundColor: BRAND.goldSoft,
    border: `1px solid ${BRAND.line}`,
    borderRadius: "8px",
    fontSize: "12px",
    lineHeight: "18px",
    textAlign: "left",
  },
};

export default InformationRequestEmail;
