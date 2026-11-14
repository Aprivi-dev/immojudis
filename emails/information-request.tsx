import { containsInformationAgentAccountInvitation } from "../src/lib/information-agent-email-template";
import {
  INFORMATION_AGENT_CNIL_COMPLAINT_URL,
  informationAgentLegalFooterLines,
  informationAgentLegalFooterSections,
  type InformationAgentLegalFooter,
} from "../src/lib/information-agent-compliance";
import {
  emailLayout,
  emailLink,
  emailPanel,
  emailParagraph,
  escapeEmailHtml,
} from "../src/lib/email-layout";

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

export const INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION = "information_request_v13";

/** Aperçu de la messagerie sous l'objet : ce qu'on attend, et que c'est facultatif. */
export const INFORMATION_REQUEST_PREHEADER =
  "Quelques points sur une annonce ; répondre est facultatif.";

type BodyBlock =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "questions"; lines: string[] }
  | { kind: "sale"; lines: string[] };

const e = escapeEmailHtml;

/**
 * Message de l'agent d'information, en forme de courrier : formule d'appel, présentation d'Immojudis
 * et origine de l'adresse, vente concernée, questions, consignes de réponse, signature ; la référence
 * de suivi et le pied juridique (art. 14 RGPD) viennent après la carte, dans l'encadré du pied.
 *
 * Les textes (corps du modèle, pied juridique de `information-agent-compliance.ts`, phrase d'origine)
 * ne sont ni réécrits ni abrégés : seuls leur place et leur mise en page changent. Cadre commun
 * (logo, carte, mode sombre) : `emailLayout()`. Pas de lien vers le site, hors opposition, dépôt
 * privé et politique de confidentialité (garde `information-agent-commercial-guard.ts`). Le dépôt
 * privé est une ligne de texte après les consignes de réponse : ni encadré doré ni bouton, qui
 * évoqueraient un hameçonnage, et aucune invitation à joindre des pièces (C13 et J15 du 14/11/2026).
 */
export function buildInformationRequestParts(props: InformationRequestEmailProps): {
  html: string;
  text: string;
} {
  const { subject, bodyText, replyTo, caseReference, contributionUrl, legalFooter } = props;
  const blocks = withOrigin(parseBodyBlocks(bodyText), legalFooter);
  const replyHref = `mailto:${replyTo}`;
  // Après le premier paragraphe qui suit les questions (« Répondre est facultatif… »), sinon à la fin.
  const lastQuestions = blocks.map((block) => block.kind).lastIndexOf("questions");
  const depositIndex =
    lastQuestions >= 0 ? Math.min(lastQuestions + 1, blocks.length - 1) : blocks.length - 1;

  const body: string[] = [];
  blocks.forEach((block, index) => {
    body.push(blockHtml(block, index === blocks.length - 1 && index !== depositIndex));
    if (contributionUrl && index === depositIndex) body.push(depositHtml(contributionUrl));
  });
  if (contributionUrl && blocks.length === 0) body.push(depositHtml(contributionUrl));
  // Une ligne sous la signature : le destinataire n'a pas à descendre jusqu'au pied pour s'opposer.
  if (legalFooter?.optOutUrl) body.push(optOutLineHtml(legalFooter.optOutUrl));

  const legalHtml = legalFooter ? legalFooterHtml(legalFooter) : { panels: "", links: [] };
  const html = emailLayout({
    title: subject,
    preheader: INFORMATION_REQUEST_PREHEADER,
    siteLinks: false,
    content: body.join(""),
    footer: {
      extraHtml: [
        emailParagraph(`Référence de suivi : ${e(caseReference)}`, {
          tone: "muted",
          size: "caption",
          marginBottom: 4,
        }),
        emailParagraph(`Adresse de réponse : ${emailLink(replyHref, e(replyTo))}`, {
          tone: "muted",
          size: "caption",
          marginBottom: 16,
        }),
        legalHtml.panels,
        emailParagraph(`${e(NOTICE_LINES[0])}<br>${e(NOTICE_LINES[1])}`, {
          tone: "muted",
          size: "caption",
          marginBottom: legalHtml.links.length ? 12 : 0,
        }),
      ].join(""),
      links: legalHtml.links,
    },
  });

  const text = textVersion({ blocks, depositIndex, props });
  return { html, text };
}

/** Mentions de transparence du pied (IA, rôle d'Immojudis, pièces). Reprises mot pour mot. */
const NOTICE_LINES = [
  "Immojudis n’agit pas au nom d’un tribunal. Une IA aide à lire et classer les réponses ; notre équipe vérifie les informations avant toute mise à jour de la fiche.",
  "Merci de ne transmettre que des pièces que vous êtes autorisé à partager.",
] as const;

const POLICY_LABEL = "Politique de confidentialité et vos droits";
const CNIL_LABEL = "Réclamation auprès de la CNIL";
const OPT_OUT_LABEL = "Ne plus être contacté";

function optOutLineHtml(optOutUrl: string): string {
  return emailParagraph(emailLink(optOutUrl, e(OPT_OUT_LABEL)), {
    tone: "muted",
    size: "caption",
    marginBottom: 0,
  });
}

/**
 * Le message à un greffe n'a pas de phrase d'origine en ouverture : « Pourquoi vous ? » n'y est pas
 * répété, l'origine reste dans « Vos données » du pied.
 */
function withOrigin(
  blocks: BodyBlock[],
  legalFooter: InformationAgentLegalFooter | undefined,
): BodyBlock[] {
  if (!legalFooter?.addressOrigin || typeof legalFooter.courtRegistryDailyCap === "number") {
    return blocks;
  }
  const origin: BodyBlock = { kind: "paragraph", lines: [legalFooter.addressOrigin] };
  const saleIndex = blocks.findIndex((block) => block.kind === "sale");
  const lead = saleIndex > 0 ? blocks[saleIndex - 1] : null;
  if (lead?.kind === "paragraph") {
    // La présentation d'Immojudis se termine par la phrase qui annonce la vente (« … sur cette vente : ») :
    // l'origine de l'adresse s'intercale entre les deux, sans toucher à un mot.
    const text = lead.lines.join(" ");
    const cut = text.lastIndexOf(". ");
    const split: BodyBlock[] =
      cut > 0 && text.endsWith(":")
        ? [
            { kind: "paragraph", lines: [text.slice(0, cut + 1)] },
            origin,
            { kind: "paragraph", lines: [text.slice(cut + 2)] },
          ]
        : [origin, lead];
    return [...blocks.slice(0, saleIndex - 1), ...split, ...blocks.slice(saleIndex)];
  }
  // Sans bloc « vente » : après la formule d'appel et le paragraphe de présentation.
  const at = Math.min(2, blocks.length);
  return [...blocks.slice(0, at), origin, ...blocks.slice(at)];
}

function blockHtml(block: BodyBlock, last: boolean): string {
  const marginBottom = last ? 0 : 16;
  if (block.kind === "questions") {
    const items = block.lines
      .map(
        (line) =>
          `<li class="ej-body" style="margin:0 0 8px;">${e(line.replace(/^[-•]\s*/, ""))}</li>`,
      )
      .join("");
    return `<ul class="ej-body" style="margin:0 0 16px;padding-left:20px;font-size:16px;line-height:24px;">${items}</ul>`;
  }
  if (block.kind === "sale") {
    return emailPanel(
      block.lines
        .map((line) => {
          const [label, value] = splitSaleLine(line);
          return emailParagraph(label ? `${e(label)} : <strong>${e(value)}</strong>` : e(value), {
            size: "fact",
            marginBottom: 8,
          });
        })
        .join(""),
    );
  }
  return emailParagraph(block.lines.map(e).join("<br>"), { marginBottom });
}

function splitSaleLine(line: string): [string | null, string] {
  const separatorIndex = line.indexOf(":");
  return separatorIndex >= 0
    ? [line.slice(0, separatorIndex).trim(), line.slice(separatorIndex + 1).trim()]
    : [null, line];
}

function depositHost(contributionUrl: string): string {
  try {
    return new URL(contributionUrl).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const DEPOSIT_LINK_TEXT = "l’espace privé de ce dossier";
const DEPOSIT_NOTE =
  "Ce lien est propre à ce dossier. Rien n’est publié sans relecture par notre équipe.";

/** « Vous pouvez aussi répondre dans <lien>, sur immojudis.com », lien et hôte déjà mis en forme. */
function depositSentence(link: string, host: string): string {
  return `Vous pouvez aussi répondre dans ${link}${host ? `, sur ${host}` : ""}`;
}

function depositHtml(contributionUrl: string): string {
  const link = emailLink(contributionUrl, e(DEPOSIT_LINK_TEXT));
  return emailParagraph(
    `${depositSentence(link, e(depositHost(contributionUrl)))}. ${e(DEPOSIT_NOTE)}`,
  );
}

function depositText(contributionUrl: string): string {
  const sentence = depositSentence(DEPOSIT_LINK_TEXT, depositHost(contributionUrl));
  return `${sentence} : ${contributionUrl}\n${DEPOSIT_NOTE}`;
}

/** Pied juridique : sections de l'art. 14 dans un encadré, opposition dans un encadré doré à part. */
function legalFooterHtml(footer: InformationAgentLegalFooter): {
  panels: string;
  links: Array<{ text: string; href: string }>;
} {
  const sections = informationAgentLegalFooterSections(footer);
  const section = (label: string, text: string) =>
    emailParagraph(`<strong>${e(label)}</strong> ${e(text)}`, {
      tone: "muted",
      size: "caption",
      marginBottom: 10,
    });
  const regular = sections.filter((entry) => entry.label !== "Opposition :");
  const objection = sections.filter((entry) => entry.label === "Opposition :");
  const panels =
    emailPanel(regular.map((entry) => section(entry.label, entry.text)).join("")) +
    objection
      .map((entry) =>
        emailPanel(
          section(entry.label, entry.text) +
            emailParagraph(emailLink(footer.optOutUrl, e(OPT_OUT_LABEL)), {
              size: "fact",
              marginBottom: 14,
            }),
          "gold",
        ),
      )
      .join("");
  return {
    panels,
    links: [
      { text: POLICY_LABEL, href: footer.privacyUrl },
      { text: CNIL_LABEL, href: INFORMATION_AGENT_CNIL_COMPLAINT_URL },
    ],
  };
}

function textVersion({
  blocks,
  depositIndex,
  props,
}: {
  blocks: BodyBlock[];
  depositIndex: number;
  props: InformationRequestEmailProps;
}): string {
  const { replyTo, caseReference, contributionUrl, legalFooter } = props;
  const out: string[] = [];
  blocks.forEach((block, index) => {
    if (block.kind === "questions") {
      out.push(block.lines.map((line) => `- ${line.replace(/^[-•]\s*/, "")}`).join("\n"));
    } else {
      out.push(block.lines.join("\n"));
    }
    if (contributionUrl && index === depositIndex) out.push(depositText(contributionUrl));
  });
  if (contributionUrl && blocks.length === 0) out.push(depositText(contributionUrl));
  if (legalFooter?.optOutUrl) out.push(`${OPT_OUT_LABEL} : ${legalFooter.optOutUrl}`);
  out.push("—", `Référence de suivi : ${caseReference}\nAdresse de réponse : ${replyTo}`);
  if (legalFooter) {
    out.push(
      ...informationAgentLegalFooterLines(legalFooter),
      `${CNIL_LABEL} : ${INFORMATION_AGENT_CNIL_COMPLAINT_URL}`,
    );
  }
  out.push(NOTICE_LINES.join("\n"));
  return out.join("\n\n");
}

export async function renderInformationRequestEmail(
  props: InformationRequestEmailProps,
): Promise<{ html: string; text: string }> {
  return buildInformationRequestParts(props);
}

/** Aperçu `email dev` : le message tel qu'il part. */
export function InformationRequestEmail(props: InformationRequestEmailProps) {
  return <div dangerouslySetInnerHTML={{ __html: buildInformationRequestParts(props).html }} />;
}

/** Lignes du bloc « vente » : « Vente concernée : … », « Audience annoncée, à confirmer : … ». */
const SALE_LINE =
  /^(Vente concernée|Référence(?: de l[’']annonce)?|Audience annoncée|Date annoncée|Date de vente annoncée|Mise à prix annoncée)(?:, à confirmer)?\s*:/i;

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

export default InformationRequestEmail;
