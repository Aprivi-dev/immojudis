import "server-only";
import { Parser } from "htmlparser2";
import type { Json } from "@/integrations/supabase/types";
import { trimmedStringValue } from "@/lib/guards";

const MAX_HTML_BODY_CHARS = 500_000;
const MAX_EXTRACTED_BODY_CHARS = 20_000;
const HTML_LINE_BREAK_TAGS = new Set([
  "blockquote",
  "br",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "p",
  "tr",
]);

export function jsonObject(value: Json | undefined): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function asOptionalString(value: Json | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function boundedInboundError(error: unknown): string {
  const value = error instanceof Error ? error.message : "Traitement entrant impossible.";
  return value.replace(/[\r\n]+/g, " ").slice(0, 500);
}

/**
 * Début de l'historique cité : séparateurs des clients de messagerie, « Le … a écrit : » (sur une
 * ou deux lignes), « On … wrote: », et l'en-tête d'un message transféré ou cité, avec ou sans
 * adresse (« De : Jean Dupont », « From: Jean Dupont », suivi de « Envoyé / Sent / Date / Objet /
 * Subject / À / To »). Le texte qui suit n'est pas du professionnel : il porte nos propres valeurs.
 */
const QUOTED_HISTORY_START_PATTERNS: RegExp[] = [
  /^(?:-{2,}\s*(?:message d.origine|original message|forwarded message|message transféré)\s*-{2,}|le .+ a écrit\s*:|on .+ wrote\s*:|de\s*:\s*.+@.+)$/imu,
  // « Le jeu. 15 oct. 2026 à 10:32, Jean <\nj@x.fr> a écrit : » : la ligne est coupée.
  /^le [^\n]{3,200}\n[^\n]{0,120}a écrit\s*:\s*$/imu,
  // En-tête Outlook ou Gmail sur plusieurs lignes, sans adresse sur la ligne « De : ».
  /^[ \t]*(?:de|from)\s*:[ \t]*\S[^\n]*\n(?:[^\n]*\n){0,4}?[ \t]*(?:envoy[ée]|sent|date|objet|subject|à|to)\s*:/imu,
  // En-tête aplati sur une seule ligne par la conversion du HTML.
  /^[ \t]*(?:de|from)\s*:[^\n]{0,200}?\b(?:envoy[ée]|sent)\s*:/imu,
  // Ligne « Envoyé : … » ou « Sent: … » qui ouvre l'en-tête d'un message cité.
  /^[ \t]*(?:envoy[ée]|sent)\s*:[^\n]{0,160}\n(?:[^\n]*\n){0,3}?[ \t]*(?:à|to|objet|subject|cc)\s*:/imu,
];

export function replyTextForExtraction(bodyText: string): string {
  let quotedIndex = -1;
  for (const pattern of QUOTED_HISTORY_START_PATTERNS) {
    const match = pattern.exec(bodyText);
    if (match && (quotedIndex < 0 || match.index < quotedIndex)) quotedIndex = match.index;
  }
  const withoutQuotedHistory = quotedIndex >= 0 ? bodyText.slice(0, quotedIndex) : bodyText;
  const mobileSignatureMatch = MOBILE_SIGNATURE_LINE_PATTERN.exec(withoutQuotedHistory);
  const withoutMobileSignature = mobileSignatureMatch
    ? withoutQuotedHistory.slice(0, mobileSignatureMatch.index)
    : withoutQuotedHistory;
  const signatureSeparatorMatch = SIGNATURE_SEPARATOR_PATTERN.exec(withoutMobileSignature);
  const withoutSignature = signatureSeparatorMatch
    ? withoutMobileSignature.slice(0, signatureSeparatorMatch.index)
    : withoutMobileSignature;
  return withoutSignature
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();
}

/** Style qui masque un élément à l'écran : texte caché pour le lecteur, lu par un outil automatique. */
const HIDDEN_STYLE_PATTERN =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)|font-size\s*:\s*0(?:px|pt|em|rem|%)?\s*(?:;|$)|mso-hide\s*:\s*all|(?:max-)?height\s*:\s*0(?:px|pt|em|rem|%)?\s*(?:;|$)[^]*overflow\s*:\s*hidden|(?:max-)?width\s*:\s*0(?:px|pt|em|rem|%)?\s*(?:;|$)[^]*overflow\s*:\s*hidden|text-indent\s*:\s*-\d{3,})/i;

function isHiddenHtmlElement(tag: string, attributes: Record<string, string>): boolean {
  if (tag === "script" || tag === "style" || tag === "template" || tag === "noscript") return true;
  if (tag === "head" || tag === "title") return true;
  if ("hidden" in attributes) return true;
  return HIDDEN_STYLE_PATTERN.test(attributes.style ?? "");
}

/** Éléments sans contenu : ils ne gardent pas d'état « caché » ouvert. */
const VOID_HTML_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

export function htmlToPlainText(value: string) {
  let output = "";
  let suppressedDepth = 0;
  // Pour chaque élément ouvert : a-t-il été masqué (script, style, display:none, hidden…) ?
  const hiddenStack: boolean[] = [];
  let quotedDepth = 0;
  const outlookDivStack: boolean[] = [];
  const append = (text: string) => {
    if (output.length >= MAX_EXTRACTED_BODY_CHARS) return;
    output += text.slice(0, MAX_EXTRACTED_BODY_CHARS - output.length);
  };
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const tag = name.toLowerCase();
        if (!VOID_HTML_TAGS.has(tag)) {
          const hidden = isHiddenHtmlElement(tag, attributes);
          hiddenStack.push(hidden);
          if (hidden) suppressedDepth += 1;
        }
        if (suppressedDepth > 0 && tag !== "div" && tag !== "blockquote") {
          // Contenu masqué : rien à écrire, mais les piles de citations restent équilibrées.
        } else if (tag === "div") {
          const isOutlookQuote = isQuotedHtmlContainer(attributes);
          outlookDivStack.push(isOutlookQuote);
          if (isOutlookQuote) {
            quotedDepth += 1;
          } else if (suppressedDepth === 0 && quotedDepth === 0) {
            append("\n");
          }
        } else if (tag === "blockquote") {
          quotedDepth += 1;
        } else if (suppressedDepth === 0 && quotedDepth === 0 && HTML_LINE_BREAK_TAGS.has(tag)) {
          append("\n");
        }
      },
      ontext(text) {
        if (suppressedDepth === 0 && quotedDepth === 0) append(text);
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if (!VOID_HTML_TAGS.has(tag) && hiddenStack.length) {
          if (hiddenStack.pop()) suppressedDepth = Math.max(0, suppressedDepth - 1);
        }
        if (suppressedDepth > 0 && tag !== "div" && tag !== "blockquote") {
          // Fin d'un élément dans une zone masquée : rien à écrire.
        } else if (tag === "div") {
          const wasOutlookQuote = outlookDivStack.pop() ?? false;
          if (wasOutlookQuote) {
            quotedDepth = Math.max(0, quotedDepth - 1);
          } else if (suppressedDepth === 0 && quotedDepth === 0) {
            append("\n");
          }
        } else if (tag === "blockquote") {
          quotedDepth = Math.max(0, quotedDepth - 1);
        } else if (suppressedDepth === 0 && quotedDepth === 0 && HTML_LINE_BREAK_TAGS.has(tag)) {
          append("\n");
        }
      },
    },
    { decodeEntities: true },
  );
  parser.end(value.slice(0, MAX_HTML_BODY_CHARS));
  return output
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isQuotedHtmlContainer(attributes: Record<string, string>): boolean {
  const id = attributes.id?.trim().toLowerCase() ?? "";
  const classes = new Set(
    (attributes.class?.toLowerCase().match(/[a-z0-9_-]+/g) ?? []).map((value) => value.trim()),
  );
  return (
    id === "divrplyfwdmsg" ||
    classes.has("gmail_quote") ||
    classes.has("gmail_attr") ||
    classes.has("yahoo_quoted") ||
    classes.has("protonmail_quote") ||
    classes.has("moz-cite-prefix")
  );
}

export function normalizeWhitespace(value: string): string {
  return value
    .replace(/[\t ]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

export function normalizeComparableText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr-FR")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Caractères sans rendu : espaces de largeur nulle, marques de direction, trait d'union conditionnel,
 * BOM et « caractères de balise » (U+E0000 à U+E007F). Ils servent à couper un mot (« ne\u200b plus »)
 * pour échapper à une détection, ou à cacher des consignes à un modèle. Retirés dès l'entrée.
 */
const INVISIBLE_CHARACTERS =
  // eslint-disable-next-line no-misleading-character-class -- chaque caractère est retiré isolément
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\u{e0000}-\u{e007f}]/gu;

export function stripInvisibleCharacters(value: string): string {
  return value.replace(INVISIBLE_CHARACTERS, "");
}

export function cleanInboundBody(text: string | null, html: string | null) {
  const plainText = stripInvisibleCharacters(text?.replace(/\r\n?/g, "\n") ?? "").trim();
  const htmlText = stripInvisibleCharacters(htmlToPlainText(html || ""));
  const source =
    (plainText && replyTextForExtraction(plainText) ? plainText : htmlText || plainText) ||
    "Réponse reçue sans corps de texte.";
  return source.slice(0, 16000);
}

export function safeFilename(value: string) {
  const safe = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return safe || "piece-jointe";
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const string = trimmedStringValue(value);
    return string ? [string] : [];
  }
  return value.flatMap((item) => {
    const string = trimmedStringValue(item);
    return string ? [string] : [];
  });
}

export function excerptAround(value: string, index: number) {
  return value.slice(Math.max(0, index - 80), Math.min(value.length, index + 240)).trim();
}

export function normalizeEmail(value: string) {
  const input = value.trim();
  if (!input) return "";

  const angleStart = input.indexOf("<");
  const angleEnd = input.indexOf(">");
  if (angleStart !== -1 || angleEnd !== -1) {
    if (
      angleStart < 0 ||
      angleEnd !== input.length - 1 ||
      input.indexOf("<", angleStart + 1) !== -1 ||
      input.indexOf(">", angleEnd + 1) !== -1 ||
      /[<>;,]/.test(input.slice(0, angleStart))
    ) {
      return "";
    }
    const address = input.slice(angleStart + 1, angleEnd).trim();
    return SIMPLE_EMAIL_PATTERN.test(address) ? address.toLowerCase() : "";
  }
  return SIMPLE_EMAIL_PATTERN.test(input) ? input.toLowerCase() : "";
}

const SIMPLE_EMAIL_PATTERN =
  /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)*$/i;

const MOBILE_SIGNATURE_LINE_PATTERN =
  /^[ \t]*(?:sent from (?:my )?(?:iphone|ipad|android(?: phone)?|(?:mobile )?phone|mobile device|galaxy)|sent from mail for windows|get outlook for (?:android|ios)|envoy[ée] (?:de|depuis) mon (?:iphone|ipad|smartphone|t[ée]l[ée]phone(?: mobile)?|appareil(?: mobile)?(?: [^\r\n]+)*|application[^\r\n]*)|envoy[ée] avec l['’]application[^\r\n]*)[ \t]*$/imu;

const SIGNATURE_SEPARATOR_PATTERN = /^[ \t]*--[ \t]*$/mu;

export function requiredHeader(request: Request, name: string) {
  const value = request.headers.get(name)?.trim();
  if (!value) throw new Error(`Signature webhook incomplète: ${name}.`);
  return value;
}

export function mergeJsonObject(current: Json, extra: Record<string, Json>): Json {
  const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  return { ...base, ...extra };
}
