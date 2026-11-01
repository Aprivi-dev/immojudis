/**
 * Contenu d'un email affiché dans l'Historique : aucun lien d'action ne doit rester actif ni lisible.
 * Un email porte des URL à jeton (confirmation d'adresse, lien magique, réinitialisation, désinscription
 * signée, opposition et dépôt de l'agent, partage de rapport) : les ouvrir depuis l'écran
 * d'administration exécuterait l'action au nom du destinataire, et les afficher en clair donnerait le
 * jeton à qui regarde l'écran.
 *
 * Deux protections, qui se superposent :
 * 1. `maskActionLinks` remplace par « [lien d’action masqué] » toute URL qui ressemble à une action : un
 *    chemin d'API, une chaîne de requête ou un fragment (jeton, signature, `t=`, `token_hash=`), un
 *    segment de chemin qui a l'allure d'un jeton, ou un mot-clé d'action. Choix de la prudence : une URL
 *    ordinaire avec un paramètre de suivi est masquée elle aussi.
 * 2. `toInertEmailDocument` (HTML) rend inertes les liens et les ressources qui resteraient (`href`, `src`
 *    déplacés vers des attributs `data-inert-*`), retire les balises actives et pose une politique de
 *    sécurité du contenu qui interdit toute requête. L'iframe qui l'affiche est de plus `sandbox=""`.
 *
 * Module pur, sans accès à la base ni au réseau.
 */
export const MASKED_LINK = "[lien d’action masqué]";

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/gi;
const ACTION_WORDS =
  /unsubscribe|desinscri|opt-?out|opposition|ne-plus|confirm|magic|recover|reset|invite|verify|contribution|depot|deposit|partage|share|signature|token|auth/i;
const TOKEN_LIKE_SEGMENT = /^[A-Za-z0-9_.~-]{20,}$/;

function looksLikeAction(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/&amp;/g, "&"));
  } catch {
    // Illisible : dans le doute, masqué.
    return true;
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return true;
  const path = parsed.pathname;
  if (/^\/api(?:\/|$)/i.test(path) || ACTION_WORDS.test(path)) return true;
  return path.split("/").some((segment) => TOKEN_LIKE_SEGMENT.test(segment));
}

/** Remplace chaque URL d'action d'un texte (brut ou HTML) par « [lien d’action masqué] ». */
export function maskActionLinks(input: string): string {
  return input.replace(URL_PATTERN, (url) => (looksLikeAction(url) ? MASKED_LINK : url));
}

const ACTIVE_BLOCKS = /<(script|iframe|object|embed|form|template)\b[\s\S]*?<\/\1\s*>/gi;
const ACTIVE_TAGS = /<\/?(?:base|link|meta|iframe|object|embed|form|input|button|script)\b[^>]*>/gi;
const LINK_ATTRIBUTES =
  /(\s)(href|src|srcset|action|formaction|background|poster|data|xlink:href)(\s*=)/gi;

const EVENT_HANDLERS = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/**
 * Document HTML sûr pour `<iframe sandbox="" srcdoc>` : liens et ressources inertes, aucune balise active,
 * aucune requête possible (politique de sécurité du contenu), après masquage des URL d'action.
 */
export function toInertEmailDocument(html: string): string {
  const cleaned = maskActionLinks(html)
    .replace(ACTIVE_BLOCKS, "")
    .replace(ACTIVE_TAGS, "")
    .replace(EVENT_HANDLERS, "")
    .replace(LINK_ATTRIBUTES, "$1data-inert-$2$3")
    .replace(/javascript:/gi, "bloque:");
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}"><meta name="referrer" content="no-referrer">${cleaned}`;
}
