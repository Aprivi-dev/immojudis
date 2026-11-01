import { Parser } from "htmlparser2";

/**
 * Contenu d'un email affiché dans l'Historique : aucun lien d'action ne doit rester actif ni lisible.
 * Un email porte des URL à jeton (confirmation d'adresse, lien magique, réinitialisation, désinscription
 * signée, opposition et dépôt de l'agent, partage de rapport) : les ouvrir depuis l'écran
 * d'administration exécuterait l'action au nom du destinataire, et les afficher en clair donnerait le
 * jeton à qui regarde l'écran.
 *
 * Le HTML n'est JAMAIS nettoyé par des expressions régulières (une balise retirée peut en reformer une autre :
 * `<scr<script>ipt>`). Il est analysé par `htmlparser2`, puis un document NEUF est reconstruit à partir d'une
 * liste blanche de balises et d'attributs : aucun fragment de l'entrée n'est recopié tel quel, tous les noms
 * sont ceux de nos constantes, toutes les valeurs sont échappées.
 *
 * - `a` devient un `span` souligné et `img` son texte `alt` entre crochets : aucun attribut d'URL n'est émis.
 * - Toute autre balise est supprimée en gardant son texte, sauf script, iframe, object, embed, form, template,
 *   svg, math, noscript, title et meta (entre autres), supprimées avec leur contenu.
 * - `<style>` est gardé, privé de `url(`, `@import`, `expression(` et `behavior` (jusqu'à stabilité).
 * - Les URL d'action sont masquées dans le texte décodé, d'un nœud à l'autre, y compris sans schéma
 *   (`//hôte/…`, `/api/…`) et coupées par un retour à la ligne ou une balise.
 * - Le document pose une politique de sécurité du contenu sans aucune requête ; l'iframe qui l'affiche est
 *   de plus `sandbox=""`.
 *
 * Module pur, sans accès à la base ni au réseau.
 */
export const MASKED_LINK = "[lien d’action masqué]";

// Une URL ne s'arrête qu'à un espace, `<`, `>` ou un guillemet : `)` et `]` en font partie.
const URL_PATTERN = /(?:https?:)?\/\/[^\s<>"']+|\/api\/[^\s<>"']*/gi;
const CONTINUATION_CHARACTER = /[?&=#/%_-]$/;
const NEXT_TOKEN = /\s+[^\s<>"']+/y;
const MAX_URL_EXTENSIONS = 5;
const ACTION_WORDS =
  /unsubscribe|desinscri|opt-?out|opposition|ne-plus|confirm|magic|recover|reset|invite|verify|contribution|depot|deposit|partage|share|signature|token|auth/i;
const TOKEN_LIKE_SEGMENT = /^[A-Za-z0-9_.~-]{20,}$/;

function looksLikeAction(candidate: string): boolean {
  const compact = candidate.replace(/\s+/g, "");
  const absolute = compact.startsWith("//")
    ? `https:${compact}`
    : compact.startsWith("/")
      ? `https://placeholder.invalid${compact}`
      : compact;
  let parsed: URL;
  try {
    parsed = new URL(absolute);
  } catch {
    // Illisible : dans le doute, masqué.
    return true;
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return true;
  const path = parsed.pathname;
  if (/^\/api(?:\/|$)/i.test(path) || ACTION_WORDS.test(path)) return true;
  return path.split("/").some((segment) => TOKEN_LIKE_SEGMENT.test(segment));
}

/** Intervalles `[début, fin[` des URL d'action d'un texte. Linéaire : aucune expression régulière imbriquée. */
function findActionRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const pattern = new RegExp(URL_PATTERN);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    let end = start + match[0].length;
    // Une URL coupée par un retour à la ligne : tant qu'elle finit sur un caractère de continuation, on
    // avale l'espace et le mot suivants.
    for (
      let step = 0;
      step < MAX_URL_EXTENSIONS && CONTINUATION_CHARACTER.test(text.slice(start, end));
      step += 1
    ) {
      NEXT_TOKEN.lastIndex = end;
      const next = NEXT_TOKEN.exec(text);
      if (!next) break;
      end += next[0].length;
    }
    if (looksLikeAction(text.slice(start, end))) ranges.push([start, end]);
    pattern.lastIndex = Math.max(end, start + 1);
  }
  return ranges;
}

/** Masque les URL d'action d'une suite de morceaux de texte, comme si elle n'en faisait qu'un. */
function maskPieces(pieces: string[]): string[] {
  const joined = pieces.join("");
  const ranges = findActionRanges(joined);
  if (ranges.length === 0) return pieces;
  let offset = 0;
  return pieces.map((piece) => {
    const from = offset;
    const to = offset + piece.length;
    offset = to;
    let out = "";
    let position = from;
    for (const [start, end] of ranges) {
      if (end <= position || start >= to) continue;
      // Un intervalle commencé dans un morceau précédent ne repose pas son marqueur.
      if (start >= position) out += joined.slice(position, start) + MASKED_LINK;
      position = Math.min(end, to);
    }
    return out + joined.slice(position, to);
  });
}

/** Remplace chaque URL d'action d'un texte brut par « [lien d’action masqué] ». */
export function maskActionLinks(input: string): string {
  return maskPieces([input])[0];
}

const ALLOWED_TAGS = new Set([
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "p",
  "div",
  "span",
  "h1",
  "h2",
  "h3",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "br",
  "hr",
  "ul",
  "ol",
  "li",
  "center",
  "font",
  "small",
  "sup",
  "sub",
  "blockquote",
  "pre",
  "code",
]);
const VOID_OUTPUT_TAGS = new Set(["br", "hr"]);
/** Supprimées avec leur contenu. */
const DROPPED_WITH_CONTENT = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "form",
  "template",
  "svg",
  "math",
  "noscript",
  "title",
  "meta",
  "frameset",
  "frame",
  "applet",
  "link",
  "base",
  "area",
]);
const ALLOWED_ATTRIBUTES = [
  "style",
  "class",
  "width",
  "height",
  "align",
  "valign",
  "bgcolor",
  "border",
  "cellpadding",
  "cellspacing",
  "colspan",
  "rowspan",
  "role",
  "dir",
  "lang",
] as const;

const MAX_INPUT_CHARS = 600_000;
const MAX_OUTPUT_CHARS = 1_200_000;
const MAX_DEPTH = 200;
const MAX_CLEAN_ROUNDS = 10;

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** CSS sans rien qui charge une ressource ou exécute : nettoyé jusqu'à stabilité, vide sinon. */
function cleanCss(css: string): string {
  let current = css;
  let previous: string;
  let rounds = 0;
  do {
    previous = current;
    current = previous
      .replace(/(?:url|image-set|src|expression)\s*\([^)]*\)?/gi, "")
      .replace(/@import[^;]*;?/gi, "")
      .replace(/behavior|-moz-binding/gi, "")
      .replace(/[\\<]/g, "");
    rounds += 1;
  } while (current !== previous && rounds < MAX_CLEAN_ROUNDS);
  return current === previous ? maskActionLinks(current) : "";
}

/** Valeur d'attribut simple : lettres, chiffres et ponctuation de mise en page, jamais `/`, `\` ni guillemets. */
const plainAttribute = (value: string) =>
  value
    .replace(/[^\p{L}\p{N}\s#%.,_:;()-]/gu, "")
    .slice(0, 200)
    .trim();

const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'";

type Frame = { kind: "drop" } | { kind: "style" } | { kind: "plain"; close: string | null };

/** Une passe : analyse l'entrée et reconstruit un document à partir de la liste blanche. */
function rebuildDocument(html: string): string | null {
  if (html.length > MAX_INPUT_CHARS) return null;
  const items: Array<string | number> = [];
  const pieces: string[] = [];
  const stack: Frame[] = [];
  let dropDepth = 0;
  let css = "";
  let outputLength = 0;
  const emit = (value: string | number) => {
    outputLength += typeof value === "number" ? pieces[value].length : value.length;
    if (outputLength > MAX_OUTPUT_CHARS) throw new Error("Contenu démesuré.");
    items.push(value);
  };

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (stack.length >= MAX_DEPTH) throw new Error("Imbrication démesurée.");
        const tag = name.toLowerCase();
        if (dropDepth > 0 || DROPPED_WITH_CONTENT.has(tag)) {
          dropDepth += 1;
          stack.push({ kind: "drop" });
          return;
        }
        if (tag === "style") {
          css = "";
          stack.push({ kind: "style" });
          return;
        }
        if (tag === "img") {
          const alternative = (attributes.alt ?? "").trim().slice(0, 300);
          if (alternative) {
            pieces.push(`[${alternative}]`);
            emit(pieces.length - 1);
          }
          stack.push({ kind: "plain", close: null });
          return;
        }
        const isLink = tag === "a";
        const output = isLink ? "span" : tag;
        if (!isLink && !ALLOWED_TAGS.has(tag)) {
          // Balise inconnue (html, body, head, label…) : supprimée, son texte reste.
          stack.push({ kind: "plain", close: null });
          return;
        }
        let rendered = `<${output}`;
        const ownStyle = attributes.style === undefined ? "" : cleanCss(attributes.style);
        const style = isLink
          ? `text-decoration:underline${ownStyle ? `;${ownStyle}` : ""}`
          : ownStyle;
        if (style) rendered += ` style="${escapeHtml(style)}"`;
        for (const attribute of ALLOWED_ATTRIBUTES) {
          if (attribute === "style") continue;
          const raw = attributes[attribute];
          const value = raw === undefined ? "" : plainAttribute(raw);
          if (value) rendered += ` ${attribute}="${escapeHtml(value)}"`;
        }
        rendered += ">";
        emit(rendered);
        stack.push({ kind: "plain", close: VOID_OUTPUT_TAGS.has(output) ? null : output });
      },
      ontext(text) {
        if (dropDepth > 0) return;
        if (stack.at(-1)?.kind === "style") {
          css += text;
          return;
        }
        pieces.push(text);
        emit(pieces.length - 1);
      },
      onclosetag() {
        const frame = stack.pop();
        if (!frame) return;
        if (frame.kind === "drop") dropDepth -= 1;
        else if (frame.kind === "style") {
          const cleaned = cleanCss(css);
          if (cleaned.trim()) emit(`<style>${cleaned}</style>`);
          css = "";
        } else if (frame.close) emit(`</${frame.close}>`);
      },
    },
    { decodeEntities: true },
  );
  try {
    parser.end(html);
  } catch {
    return null;
  }
  if (!pieces.some((piece) => piece.trim())) return null;

  const masked = maskPieces(pieces);
  const body = items
    .map((item) => (typeof item === "number" ? escapeHtml(masked[item]) : item))
    .join("");
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}"><meta name="referrer" content="no-referrer"><body>${body}</body>`;
}

/** Reconstructions successives au plus : l'analyse d'un HTML mal formé n'est pas toujours stable du premier coup. */
const MAX_REBUILDS = 4;

/**
 * Document HTML sûr pour `<iframe sandbox="" srcdoc>`, reconstruit à partir d'une liste blanche, puis
 * reconstruit encore jusqu'à ce que le résultat ne change plus (donc idempotent). `null` quand l'analyse échoue,
 * que le contenu est démesuré, qu'il ne reste aucun texte ou que le résultat ne se stabilise pas : l'appelant
 * affiche alors la version texte, masquée.
 */
export function toInertEmailDocument(html: string): string | null {
  let document = rebuildDocument(html);
  for (let round = 0; document !== null && round < MAX_REBUILDS; round += 1) {
    const next = rebuildDocument(document);
    if (next === document) return document;
    document = next;
  }
  return null;
}
