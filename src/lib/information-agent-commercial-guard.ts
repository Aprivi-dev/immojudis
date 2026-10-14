/**
 * Garde « aucune mention commerciale » du message de l'agent d'information.
 *
 * Une demande d'information sur la vente qu'un professionnel mène n'est pas de la prospection : le
 * message reste purement informatif (cadrage juridique du 14/10/2026, § 2.5 et 7.8). Sont refusés
 * dans le gabarit, l'objet, le corps et le HTML rendu :
 * - les offres commerciales, abonnements, comptes et inscriptions ;
 * - la « mise en avant » ;
 * - les prix et tarifs d'Immojudis ;
 * - tout lien vers le site d'Immojudis hors des pages utiles au destinataire (politique de
 *   confidentialité, dépôt privé, opposition), donc `/offres`, l'inscription, la connexion, etc.
 *
 * « Mise à prix », « offre d'achat », « dépôt des offres » et « aucun compte n'est nécessaire »
 * décrivent la vente ou rassurent le destinataire : ils restent permis.
 */

export type InformationAgentCommercialMention = {
  /** Règle déclenchée. */
  rule: "offer" | "account" | "promotion" | "price" | "link";
  /** Extrait fautif (ou lien). */
  excerpt: string;
};

/** Formules rassurantes qui contiennent « compte » ou « offre » sans rien promouvoir. */
const ALLOWED_PHRASES: RegExp[] = [
  /sans\s+(?:avoir\s+[àa]\s+)?cr[ée]er\s+(?:de|un)\s+(?:nouveau\s+)?compte/gi,
  /sans\s+(?:avoir\s+(?:de|un)\s+)?compte/gi,
  /aucun\s+compte\s+n[’']est\s+(?:n[ée]cessaire|requis)/gi,
  /pas\s+(?:besoin\s+)?d[’'e]\s*(?:un\s+)?compte/gi,
  /(?:aucune|sans)\s+(?:offre|sollicitation)s?\s+commerciale/gi,
  /modalit[ée]s?\s+d[’']inscription/gi,
  /mise\s+[àa]\s+prix/gi,
  /prix\s+d[’']adjudication/gi,
  /prix\s+de\s+(?:vente|r[ée]serve)/gi,
  /offres?\s+d[’']achat/gi,
  /d[ée]p[ôo]t\s+des\s+offres/gi,
  /offres?\s+(?:minimale|maximale|recevable|re[çc]ue)s?/gi,
];

const RULES: Array<{ rule: InformationAgentCommercialMention["rule"]; pattern: RegExp }> = [
  {
    rule: "offer",
    pattern:
      /\b(?:nos|notre|l[’']|une?|des?|les)?\s*offres?\s+(?:commerciale|payante|gratuite|d[’']abonnement|analyse|d[ée]couverte|pro(?:fessionnelle)?|premium)s?\b|\bnos\s+offres\b|\boffre\s+(?:sp[ée]ciale|promotionnelle)\b|\b(?:abonnements?|abonn(?:er|ez|ons)|souscri(?:re|vez|ption)|essai\s+gratuit|premium|pack|forfait)\b/gi,
  },
  {
    rule: "account",
    pattern:
      /\bcr[ée]+(?:er|ez|ation)\s+(?:de\s+|d[’']un\s+|votre\s+|un\s+)?(?:nouveau\s+)?compte\b|\bcompte\s+(?:professionnel|gratuit|pro|avocat)\b|\b(?:inscri(?:re|vez|ption|ptions)|inscrivez-vous|s[’']inscrire|espace\s+pro(?:fessionnel)?|connectez-vous|se\s+connecter)\b/gi,
  },
  {
    rule: "promotion",
    pattern:
      /\bmise\s+en\s+avant\b|\b(?:sponsoris|r[ée]f[ée]rencement|visibilit[ée]|annuaire\s+des\s+avocats|promotion|promouvoir|publicit[ée])\w*/gi,
  },
  {
    rule: "price",
    pattern:
      /\b(?:tarifs?|tarification|co[uû]t\s+de\s+l[’']offre)\b|\b\d[\d\s.,]*\s?(?:€|euros?)\s*(?:\/|par\s+)\s*(?:mois|an|ann[ée]e|vente)\b|\b\d[\d\s.,]*\s?(?:€|euros?)\s*(?:HT|TTC)\b|\b(?:HT|TTC)\b|\bprix\b/gi,
  },
];

/** Pages d'Immojudis que le message peut légitimement lier. */
const ALLOWED_APP_PATHS: RegExp[] = [
  /^\/$/,
  /^\/privacy\/?$/,
  /^\/contribuer\/[^/]+\/?$/,
  /^\/api\/information-agent\/opt-out\/?$/,
  /^\/agent-information\/?$/,
];

const ABSOLUTE_URL = /https?:\/\/[^\s"'<>)\]]+/gi;
const HREF = /href\s*=\s*"([^"]*)"/gi;

/** Texte visible d'un HTML rendu : sans balises, entités courantes décodées, espaces insécables. */
function normalizeSpaces(text: string): string {
  return text
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|[\u00a0\u202f]/g, " ");
}

function stripAllowedPhrases(text: string): string {
  return ALLOWED_PHRASES.reduce((current, pattern) => current.replace(pattern, " "), text);
}

function linkMentions(
  text: string,
  appOrigin: string | null | undefined,
): InformationAgentCommercialMention[] {
  if (!appOrigin) return [];
  let appHost: string;
  try {
    appHost = new URL(appOrigin).host.toLowerCase();
  } catch {
    return [];
  }
  const found: InformationAgentCommercialMention[] = [];
  const candidates = [...text.matchAll(ABSOLUTE_URL)].map((match) => match[0]);
  for (const href of text.matchAll(HREF)) {
    if (href[1]) candidates.push(href[1].replace(/&amp;/g, "&"));
  }
  for (const candidate of candidates) {
    let url: URL;
    try {
      url = new URL(candidate, appOrigin);
    } catch {
      continue;
    }
    const host = url.host.toLowerCase();
    const sameSite = host === appHost || host.endsWith(`.${appHost.replace(/^www\./, "")}`);
    if (!sameSite) continue;
    if (!ALLOWED_APP_PATHS.some((pattern) => pattern.test(url.pathname))) {
      found.push({ rule: "link", excerpt: candidate });
    }
  }
  return found;
}

/**
 * Mentions commerciales d'un texte (gabarit, objet, corps, texte brut ou HTML rendu). Avec
 * `appOrigin`, les liens vers le site d'Immojudis sont aussi contrôlés.
 */
export function findInformationAgentCommercialMentions(
  text: string,
  { appOrigin }: { appOrigin?: string | null } = {},
): InformationAgentCommercialMention[] {
  const links = linkMentions(text, appOrigin);
  // Le HTML rendu est contrôlé sur son texte visible ; les attributs sont déjà traités ci-dessus.
  const visible = stripAllowedPhrases(normalizeSpaces(text.replace(/<[^>]+>/g, " ")));
  const found: InformationAgentCommercialMention[] = [...links];
  for (const { rule, pattern } of RULES) {
    for (const match of visible.matchAll(pattern)) {
      found.push({ rule, excerpt: match[0].trim() });
    }
  }
  return found;
}

export function assertNoInformationAgentCommercialMention(
  text: string,
  options: { appOrigin?: string | null } = {},
): void {
  const mentions = findInformationAgentCommercialMentions(text, options);
  if (mentions.length) {
    const list = [...new Set(mentions.map((mention) => `« ${mention.excerpt} »`))].slice(0, 5);
    throw new Error(
      `Le message ne doit contenir aucune mention commerciale (offre, compte, inscription, mise en avant, prix, lien vers les offres) : ${list.join(", ")}.`,
    );
  }
}
