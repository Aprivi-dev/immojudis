import {
  EMAIL_BRAND_NAME,
  EMAIL_COLORS,
  EMAIL_CONTACT_ADDRESS,
  EMAIL_DARK_COLORS,
  EMAIL_FONT_STACK,
  EMAIL_LOGO_DARK_URL,
  EMAIL_LOGO_LIGHT_URL,
  EMAIL_SITE_URL,
} from "./email-brand";

/**
 * Modèle unique des emails HTML d'Immojudis : un seul cadre (page, carte à filet or, logo, pied,
 * mode sombre) et quelques blocs (surtitre, titre, bouton, carte de vente, encadré). Tous les
 * gabarits (alertes, rappels, récapitulatif, résultats, ouverture, fin d'essai, facturation, mise en
 * relation, incident, agent d'information, emails d'authentification Supabase) passent par
 * `emailLayout()` : la mise en page ne se règle qu'ici.
 *
 * Règles de la charte (docs/equipe, 01/11/2026) :
 * - tableaux (`<table role="presentation">`), pas de `div` de mise en page : Outlook de bureau les lit ;
 * - carte de 600 px au plus, rayon 10 px, bordure 1 px `line`, filet or de 4 px en haut de la carte ;
 * - couleurs explicites partout (en ligne), classes `ej-*` seulement pour le mode sombre et le mobile ;
 * - jamais de blanc ni de noir pur en couleur de texte, hors bouton ;
 * - pas de module serveur ici : les gabarits `emails/*.tsx` et les tests l'importent aussi.
 *
 * Les paramètres nommés `html` sont du HTML DÉJÀ échappé ; ceux nommés `text` sont du texte brut,
 * échappé ici.
 */

const C = EMAIL_COLORS;
const D = EMAIL_DARK_COLORS;
const FONT = EMAIL_FONT_STACK;
const MONO = "Consolas, Menlo, 'Courier New', monospace";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Échappe le texte et les valeurs d'attribut (comme `escapeHtml` de `guards.ts`, sans dépendance). */
export function escapeEmailHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

const esc = escapeEmailHtml;
/** Valeur d'attribut `href` : même échappement, plus l'accent grave. */
const attr = (value: string) => esc(value).replace(/`/g, "&#96;");

type Tone = "navy" | "body" | "muted" | "link";

const TONES: Record<Tone, { color: string; className: string }> = {
  navy: { color: C.navy, className: "ej-navy" },
  body: { color: C.inkStrong, className: "ej-body" },
  muted: { color: C.inkSoft, className: "ej-muted" },
  link: { color: C.goldText, className: "ej-link" },
};

const SIZES = {
  /** Corps : 16/24. */
  body: { size: 16, line: 24 },
  /** Faits d'une carte de vente et lieu : 15/22. */
  fact: { size: 15, line: 22 },
  /** Légende, pied : 13/19. */
  caption: { size: 13, line: 19 },
} as const;
type Size = keyof typeof SIZES;

function typeStyle(size: Size, tone: Tone, weight = 400): string {
  const { size: px, line } = SIZES[size];
  return `font-family:${FONT};font-size:${px}px;line-height:${line}px;font-weight:${weight};color:${TONES[tone].color};`;
}

/** Paragraphe. `html` est déjà échappé. */
export function emailParagraph(
  html: string,
  options: { tone?: Tone; size?: Size; weight?: number; marginBottom?: number } = {},
): string {
  const { tone = "body", size = "body", weight = 400, marginBottom = 16 } = options;
  return `<p class="${TONES[tone].className}" style="margin:0 0 ${marginBottom}px;${typeStyle(size, tone, weight)}">${html}</p>`;
}

/** Surtitre : 12 px, 700, capitales, `goldText`. */
export function emailEyebrow(text: string, options: { marginBottom?: number } = {}): string {
  const { marginBottom = 8 } = options;
  return `<p class="ej-link" style="margin:0 0 ${marginBottom}px;font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.goldText};">${esc(text)}</p>`;
}

/** Titre : h1 22/30 700, h2 17/24 700. `text` est du texte brut. */
export function emailHeading(
  text: string,
  level: 1 | 2 = 1,
  options: { marginBottom?: number; marginTop?: number } = {},
): string {
  const { marginBottom = level === 1 ? 12 : 8, marginTop = 0 } = options;
  const [size, line] = level === 1 ? [22, 30] : [17, 24];
  return `<h${level} class="ej-navy" style="margin:${marginTop}px 0 ${marginBottom}px;font-family:${FONT};font-size:${size}px;line-height:${line}px;font-weight:700;color:${C.navy};">${esc(text)}</h${level}>`;
}

/** Lien tertiaire : `goldText`, souligné, 600. `html` est déjà échappé. */
export function emailLink(
  href: string,
  html: string,
  options: { breakAll?: boolean } = {},
): string {
  return `<a href="${attr(href)}" class="ej-link" style="color:${C.goldText};text-decoration:underline;font-weight:600;${options.breakAll ? "word-break:break-all;overflow-wrap:anywhere;" : ""}">${html}</a>`;
}

/**
 * Bouton « blindé » : cellule colorée + lien en bloc en ligne + bordure de la même couleur (Outlook
 * ignore le padding d'un lien). 16/20 700, rayon 6 px, 12 px 20 px de marge intérieure (46 px de
 * haut), pleine largeur sous 480 px. Un seul bouton principal par message ou par carte de vente.
 */
export function emailButton(
  href: string,
  text: string,
  options: { variant?: "primary" | "secondary"; marginBottom?: number } = {},
): string {
  const { variant = "primary", marginBottom = 16 } = options;
  const primary = variant === "primary";
  const cellStyle = primary
    ? `background-color:${C.navy};border:1px solid ${C.navy};border-radius:6px;`
    : `border:1px solid ${C.navy};border-radius:6px;`;
  const color = primary ? C.white : C.navy;
  const linkStyle = `display:inline-block;padding:12px 20px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:700;color:${color};text-decoration:none;border-radius:6px;`;
  return `<table role="presentation" class="ej-btn" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:0 0 ${marginBottom}px;"><tr><td class="${primary ? "ej-btn-cell" : "ej-btn2-cell"}"${primary ? ` bgcolor="${C.navy}"` : ""} style="${cellStyle}"><a href="${attr(href)}" class="${primary ? "ej-btn-a" : "ej-btn2-a"}" style="${linkStyle}">${esc(text)}</a></td></tr></table>`;
}

/** Texte à découper n'importe où : identifiants, empreintes, adresses longues (monospace 13 px). */
export function emailBreakable(text: string): string {
  return `<span class="ej-navy" style="font-family:${MONO};font-size:13px;line-height:19px;color:${C.navy};word-break:break-all;overflow-wrap:anywhere;">${esc(text)}</span>`;
}

/**
 * Encadré : `muted` (fond `surfaceMuted`) ou `gold` (fond `cream`), bordure `lineWarm`, rayon 8 px.
 * `html` est le contenu déjà formé (paragraphes) ; leur dernière marge est absorbée.
 */
export function emailPanel(html: string, tone: "muted" | "gold" = "muted"): string {
  const background = tone === "gold" ? C.cream : C.surfaceMuted;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 16px;"><tr><td class="ej-panel" bgcolor="${background}" style="background-color:${background};border:1px solid ${C.lineWarm};border-radius:8px;padding:16px 16px 0;">${html}</td></tr></table>`;
}

/** Tableau « libellé / valeur » (15 px, libellés 400, valeurs 700). Textes bruts, échappés ici. */
export function emailKeyValueRows(
  rows: ReadonlyArray<readonly [label: string, value: string]>,
): string {
  const body = rows
    .map(
      ([label, value]) =>
        `<tr><td class="ej-muted" valign="top" style="padding:6px 16px 6px 0;${typeStyle("fact", "muted")}">${esc(label)}</td><td class="ej-navy" valign="top" style="padding:6px 0;${typeStyle("fact", "navy", 700)}word-break:break-word;overflow-wrap:anywhere;">${esc(value)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 16px;">${body}</table>`;
}

/** Bloc de texte brut (diagnostic, journal) : monospace 13 px, retours à la ligne gardés, mots coupés. */
export function emailPreformatted(text: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 16px;"><tr><td class="ej-panel" bgcolor="${C.surfaceMuted}" style="background-color:${C.surfaceMuted};border:1px solid ${C.lineWarm};border-radius:8px;padding:12px;"><p class="ej-navy" style="margin:0;font-family:${MONO};font-size:13px;line-height:19px;color:${C.navy};white-space:pre-wrap;word-break:break-all;overflow-wrap:anywhere;">${esc(text)}</p></td></tr></table>`;
}

export type EmailFact = { label?: string; value: string };

/**
 * Carte de vente (alerte, rappel, récapitulatif, résultat, agent) : surtitre éventuel, titre 18/24
 * 700, lieu 15 px, faits 15 px (libellés 400, valeurs 700), notes libres, un bouton, séparateur de
 * 1 px au-dessus. Les mentions juridiques restent là où le gabarit les met : `notesHtml`.
 */
export function emailSaleCard(card: {
  eyebrow?: string | null;
  title: string;
  location?: string | null;
  facts?: readonly EmailFact[];
  /** Blocs libres (HTML déjà formé) sous les faits : mentions, critères… */
  notesHtml?: string;
  action?: { href: string; text: string } | null;
  /** Lien tertiaire à côté du bouton (« Ajouter à mon agenda »). */
  secondaryLink?: { href: string; text: string } | null;
}): string {
  const parts: string[] = [];
  if (card.eyebrow) parts.push(emailEyebrow(card.eyebrow, { marginBottom: 6 }));
  parts.push(
    `<h2 class="ej-navy" style="margin:0 0 4px;font-family:${FONT};font-size:18px;line-height:24px;font-weight:700;color:${C.navy};">${esc(card.title)}</h2>`,
  );
  if (card.location) {
    parts.push(
      emailParagraph(esc(card.location), { tone: "muted", size: "fact", marginBottom: 8 }),
    );
  }
  for (const fact of card.facts ?? []) {
    const value = `<strong class="ej-navy" style="font-weight:700;color:${C.navy};">${esc(fact.value)}</strong>`;
    parts.push(
      emailParagraph(fact.label ? `${esc(fact.label)} : ${value}` : value, {
        size: "fact",
        marginBottom: 6,
      }),
    );
  }
  if (card.notesHtml) parts.push(card.notesHtml);
  const actions: string[] = [];
  if (card.action)
    actions.push(emailButton(card.action.href, card.action.text, { marginBottom: 8 }));
  if (card.secondaryLink) {
    actions.push(
      emailParagraph(emailLink(card.secondaryLink.href, esc(card.secondaryLink.text)), {
        size: "fact",
        marginBottom: 8,
      }),
    );
  }
  parts.push(...actions);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 4px;"><tr><td class="ej-rule" style="padding:20px 0 12px;border-top:1px solid ${C.lineWarm};">${parts.join("")}</td></tr></table>`;
}

export type EmailFooter = {
  /** Phrase de raison propre à l'email (« Vous recevez ce message parce que… »), texte brut. */
  reason?: string;
  /** Blocs libres entre la raison et les liens (pied juridique de l'agent d'information), HTML formé. */
  extraHtml?: string;
  /** Liens du pied, séparés par « · ». */
  links?: ReadonlyArray<{ text: string; href: string }>;
  /**
   * Message automatique « ne pas répondre » : ajoute en dernier du pied la mention
   * « Message automatique, merci de ne pas y répondre. Pour nous écrire : contact@… » (lien `mailto:`).
   * La version texte du message reprend la même phrase par `emailNoReplyText()`.
   */
  noReply?: boolean;
};

/** Mention des emails automatiques, sans l'adresse : une seule source pour le HTML et le texte. */
const NO_REPLY_SENTENCE = "Message automatique, merci de ne pas y répondre. Pour nous écrire :";

/** La mention « ne pas répondre » en texte brut, à ajouter en dernière ligne de la version texte. */
export function emailNoReplyText(): string {
  return `${NO_REPLY_SENTENCE} ${EMAIL_CONTACT_ADDRESS}`;
}

/** Texte d'aperçu (préheader) : au plus 100 caractères, coupé à un mot. */
export function emailPreheaderFrom(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

function darkAndMobileCss(): string {
  return `
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; }
    img { -ms-interpolation-mode: bicubic; }
    @media only screen and (max-width: 480px) {
      .ej-outer { padding: 12px 8px !important; }
      .ej-pad { padding-left: 20px !important; padding-right: 20px !important; }
      .ej-content { padding-top: 20px !important; padding-bottom: 20px !important; }
      .ej-btn { width: 100% !important; }
      .ej-btn-cell, .ej-btn2-cell { display: block !important; width: 100% !important; box-sizing: border-box !important; }
      .ej-btn-a, .ej-btn2-a { display: block !important; text-align: center !important; }
    }
    @media (prefers-color-scheme: dark) {
      .ej-page { background-color: ${D.page} !important; }
      .ej-card { background-color: ${D.card} !important; border-color: ${D.line} !important; }
      .ej-navy, .ej-body { color: ${D.text} !important; }
      .ej-muted { color: ${D.muted} !important; }
      .ej-link { color: ${D.link} !important; }
      .ej-rule { border-color: ${D.line} !important; }
      .ej-panel { background-color: ${D.page} !important; border-color: ${D.line} !important; }
      .ej-btn-cell { background-color: ${D.button} !important; border-color: ${D.button} !important; }
      .ej-btn-a { color: ${C.navy} !important; }
      .ej-btn2-cell { border-color: ${D.button} !important; }
      .ej-btn2-a { color: ${D.button} !important; }
      .logo-light { display: none !important; max-height: 0 !important; overflow: hidden !important; }
      .logo-dark { display: block !important; max-height: none !important; overflow: visible !important; }
    }`;
}

/** Logo : PNG clair par défaut, PNG sombre montré par `.logo-dark` en mode sombre. */
function logoHtml(link: boolean): string {
  const base = `border:0;width:144px;height:32px;font-family:${FONT};font-size:22px;line-height:32px;font-weight:700;`;
  const images = `<img class="logo-light" src="${EMAIL_LOGO_LIGHT_URL}" width="144" height="32" alt="${EMAIL_BRAND_NAME}" style="display:block;${base}color:${C.navy};"><img class="logo-dark" src="${EMAIL_LOGO_DARK_URL}" width="144" height="32" alt="" style="display:none;max-height:0;overflow:hidden;mso-hide:all;${base}color:${D.text};">`;
  return link
    ? `<a href="${EMAIL_SITE_URL}" style="text-decoration:none;display:block;">${images}</a>`
    : images;
}

/**
 * Le cadre complet d'un email : doctype, `<head>` (titre, viewport, schéma de couleurs, mode sombre,
 * mobile), préheader masqué, page, carte (filet or, logo, contenu, pied) et ligne de marque hors
 * carte. `footer: null` pour un email interne (incident) : ni pied ni ligne de marque.
 */
export function emailLayout(options: {
  /** Contenu de `<title>` : l'objet du message. */
  title: string;
  /** Texte d'aperçu masqué dans le message (≤ 100 caractères). */
  preheader: string;
  /** Contenu de la carte : HTML déjà formé, par les blocs ci-dessus. */
  content: string;
  footer: EmailFooter | null;
  /**
   * Liens vers le site (logo cliquable, domaine et contact de la ligne de marque). Faux pour l'agent
   * d'information : son message ne renvoie vers aucune page d'Immojudis hors opposition, dépôt privé
   * et politique de confidentialité (`information-agent-commercial-guard.ts`) ; la ligne de marque
   * se réduit au nom.
   */
  siteLinks?: boolean;
}): string {
  const { title, preheader, content, footer, siteLinks = true } = options;
  const links =
    footer?.links
      ?.map((link) => emailLink(link.href, esc(link.text)))
      .join(` <span class="ej-muted" style="color:${C.inkSoft};">·</span> `) ?? "";
  const footerRow =
    footer && (footer.reason || footer.extraHtml || links || footer.noReply)
      ? `<tr><td class="ej-pad ej-rule" style="padding:20px 28px 24px;border-top:1px solid ${C.lineWarm};font-family:${FONT};word-break:break-word;overflow-wrap:anywhere;">${
          footer.reason
            ? emailParagraph(esc(footer.reason), {
                tone: "muted",
                size: "caption",
                marginBottom: links || footer.extraHtml || footer.noReply ? 8 : 0,
              })
            : ""
        }${footer.extraHtml ?? ""}${links ? `<p class="ej-muted" style="margin:0${footer.noReply ? " 0 8px" : ""};${typeStyle("caption", "muted")}">${links}</p>` : ""}${
          footer.noReply
            ? `<p class="ej-muted" style="margin:0;${typeStyle("caption", "muted")}">${esc(NO_REPLY_SENTENCE)} ${emailLink(`mailto:${EMAIL_CONTACT_ADDRESS}`, esc(EMAIL_CONTACT_ADDRESS))}</p>`
            : ""
        }</td></tr>`
      : "";
  const brandText = siteLinks
    ? `${EMAIL_BRAND_NAME} · <a href="${EMAIL_SITE_URL}" class="ej-muted" style="color:${C.inkSoft};text-decoration:underline;">immojudis.com</a> · <a href="mailto:${EMAIL_CONTACT_ADDRESS}" class="ej-muted" style="color:${C.inkSoft};text-decoration:underline;">${EMAIL_CONTACT_ADDRESS}</a>`
    : EMAIL_BRAND_NAME;
  const brandLine = footer
    ? `<tr><td align="center" class="ej-muted" style="padding:16px 8px 0;${typeStyle("caption", "muted")}text-align:center;">${brandText}</td></tr>`
    : "";
  const hidden = `${esc(emailPreheaderFrom(preheader))}${"&nbsp;&zwnj;".repeat(40)}`;

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(title)}</title>
<style>${darkAndMobileCss()}
</style>
</head>
<body class="ej-page" style="margin:0;padding:0;background-color:${C.background};">
<span data-skip-in-text="true" style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:${C.background};">${hidden}</span>
<table role="presentation" class="ej-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.background}" style="width:100%;background-color:${C.background};"><tr><td align="center" class="ej-outer" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;"><tr><td>
<table role="presentation" class="ej-card" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.white}" style="width:100%;background-color:${C.white};border:1px solid ${C.line};border-radius:10px;border-collapse:separate;border-spacing:0;">
<tr><td height="4" bgcolor="${C.gold}" style="height:4px;line-height:4px;font-size:0;background-color:${C.gold};border-radius:9px 9px 0 0;">&nbsp;</td></tr>
<tr><td class="ej-pad ej-rule" style="padding:20px 28px 16px;border-bottom:1px solid ${C.lineWarm};">${logoHtml(siteLinks)}</td></tr>
<tr><td class="ej-pad ej-content" style="padding:28px;font-family:${FONT};word-break:break-word;overflow-wrap:anywhere;">${content}</td></tr>
${footerRow}
</table>
</td></tr>${brandLine ? `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${brandLine}</table></td></tr>` : ""}</table>
</td></tr></table>
</body>
</html>`;
}
