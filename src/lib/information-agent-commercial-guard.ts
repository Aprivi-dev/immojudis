/**
 * Garde « aucune mention commerciale » du message de l'agent d'information.
 *
 * Une demande d'information sur la vente qu'un professionnel mène n'est pas de la prospection : le
 * message reste purement informatif (cadrage juridique du 14/10/2026, § 2.5 et 7.8). Sont refusés
 * dans le gabarit, l'objet, le corps et le HTML rendu :
 * - les offres commerciales, abonnements, comptes et inscriptions ;
 * - la « mise en avant », le partenariat, la mise en relation, la clientèle, la gratuité ;
 * - les prix et tarifs d'Immojudis ;
 * - tout lien, sauf le site d'Immojudis sur ses pages utiles au destinataire (politique de
 *   confidentialité, dépôt privé, opposition), la plainte CNIL et la page source de l'adresse.
 *
 * Le vocabulaire de la vente reste permis : « mise à prix », « prix de départ », « prix atteint »,
 * « offre d'achat », « dépôt des offres », « émoluments », « inscription hypothécaire », « publicité
 * de la vente », « promotion immobilière », « plateforme de vente »… La garde cherche des formes
 * commerciales précises, pas des mots isolés : un faux positif bloquerait un message légitime.
 */

export type InformationAgentCommercialMention = {
  /** Règle déclenchée. */
  rule: "offer" | "account" | "promotion" | "price" | "link";
  /** Extrait fautif (ou lien). */
  excerpt: string;
};

/** Formules de la vente ou rassurantes qui contiennent un mot surveillé sans rien promouvoir. */
const ALLOWED_PHRASES: RegExp[] = [
  /sans\s+(?:avoir\s+[àa]\s+)?cr[ée]er\s+(?:de|un)\s+(?:nouveau\s+)?compte/gi,
  /sans\s+(?:avoir\s+(?:de|un)\s+)?compte/gi,
  /aucun\s+compte\s+n[’']est\s+(?:n[ée]cessaire|requis)/gi,
  /pas\s+(?:besoin\s+)?d[’'e]\s*(?:un\s+)?compte/gi,
  /(?:aucune|sans)\s+(?:offre|sollicitation)s?\s+commerciale/gi,
  /(?:plateforme|plate-forme)\s+(?:de\s+vente|d[’']ench[èe]res?)/gi,
  /offres?\s+d[’']achat/gi,
  /d[ée]p[ôo]t\s+des\s+offres/gi,
  /offres?\s+(?:minimale|maximale|recevable|re[çc]ue)s?/gi,
];

const RULES: Array<{ rule: InformationAgentCommercialMention["rule"]; pattern: RegExp }> = [
  {
    rule: "offer",
    pattern:
      /\b(?:nos|notre|l[’']|une?)?\s*offres?\s+(?:commerciale|payante|gratuite|d[’']abonnement|analyse|d[ée]couverte|pro(?:fessionnelle)?|premium|sp[ée]ciale|promotionnelle)s?\b|\bnos\s+offres\b|\bnotre\s+offre\b|\b(?:abonnements?|abonn(?:er|ez|ons)|souscri(?:re|vez|ption)|essai\s+gratuit|premium)\b|\bgratuit(?:e|es|s|ement)?\b|\bnewsletter\b|\bd[ée]monstration\b|\bpartenaires?\b|\bpartenariats?\b|\bcollaboration\b|\bmise\s+en\s+relation\b|\bplate-?forme\b|\bclient[èe]le\b/gi,
  },
  {
    rule: "account",
    pattern:
      /\bcr[ée]+(?:er|ez|ation)\s+(?:de\s+|d[’']un\s+|votre\s+|un\s+)?(?:nouveau\s+)?compte\b|\bcompte\s+(?:professionnel|gratuit|pro|avocat)\b|\b(?:inscrivez-vous|s[’']inscrire|inscription\s+(?:gratuite|professionnelle|en\s+ligne|sur\s+immojudis|[àa]\s+immojudis)|espace\s+pro(?:fessionnel)?|connectez-vous|se\s+connecter)\b/gi,
  },
  {
    rule: "promotion",
    pattern:
      /\bmise\s+en\s+avant\b|\bsponsoris\w*|\br[ée]f[ée]renc(?:ement|er)\b|\bpromouvoir\b|\bannuaire\s+des\s+avocats\b/gi,
  },
  {
    rule: "price",
    pattern:
      /\bnos\s+(?:tarifs?|prix)\b|\bnotre\s+(?:tarif|prix)\b|\btarif(?:s|ication)?\s+(?:d[’']immojudis|de\s+(?:nos|l[’']offre)|d[’']abonnement|mensuel|annuel)\b|\bprix\s+(?:de\s+l[’']offre|d[’']abonnement|de\s+nos)\b|\b\d[\d\s.,]*\s?(?:€|euros?)\s*(?:\/|par\s+)\s*(?:mois|an|ann[ée]e|vente)\b|\b\d[\d\s.,]*\s?(?:€|euros?)\s*(?:HT|TTC)\b|\bpar\s+mois\b/gi,
  },
];

/** Pages d'Immojudis que le message peut légitimement lier (la page d'accueil n'en fait pas partie). */
const ALLOWED_APP_PATHS: RegExp[] = [
  /^\/privacy\/?$/,
  /^\/contribuer\/[^/]+\/?$/,
  /^\/api\/information-agent\/opt-out\/?$/,
];

/** Hôtes tiers admis : la plainte CNIL. */
const ALLOWED_EXTERNAL_HOSTS = new Set(["www.cnil.fr"]);

const ABSOLUTE_URL = /https?:\/\/[^\s"'<>)\]]+/gi;
const HREF = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const INVISIBLE = /[\u00ad\u200b-\u200f\u2060\u2066-\u2069\ufeff]/g;

export type InformationAgentCommercialGuardOptions = {
  /** Origine du site d'Immojudis : ses liens sont limités aux pages utiles au destinataire. */
  appOrigin?: string | null;
  /** URL de la page source de l'adresse, seul lien tiers admis avec la plainte CNIL. */
  allowedUrls?: ReadonlyArray<string | null | undefined>;
  /**
   * Textes issus d'une annonce ou d'un registre (référence de la vente…) : écartés avant l'analyse,
   * pour qu'un mot de l'annonce ne fasse pas échouer un message déjà approuvé.
   */
  ignore?: ReadonlyArray<string | null | undefined>;
};

/** Entités courantes décodées, caractères invisibles et espaces insécables normalisés. */
export function normalizeInformationAgentGuardText(text: string): string {
  return (
    text
      .replace(INVISIBLE, "")
      // Déclarations du HTML rendu (DOCTYPE, espaces de noms) : des URL techniques, pas des liens.
      .replace(/<!doctype[^>]*>/gi, " ")
      .replace(/\sxmlns(?::\w+)?\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
      .replace(/&#x27;|&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;|[\u00a0\u202f]/g, " ")
      // `&amp;` en dernier : décodé plus tôt, `&amp;nbsp;` serait décodé deux fois (CodeQL).
      .replace(/&amp;/g, "&")
  );
}

function withoutHostPrefix(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function linkMentions(
  text: string,
  { appOrigin, allowedUrls = [] }: InformationAgentCommercialGuardOptions,
): InformationAgentCommercialMention[] {
  let appHost: string | null = null;
  if (appOrigin) {
    try {
      appHost = withoutHostPrefix(new URL(appOrigin).host);
    } catch {
      appHost = null;
    }
  }
  const allowed = new Set<string>();
  for (const url of allowedUrls) {
    if (!url) continue;
    try {
      const parsed = new URL(url);
      allowed.add(`${withoutHostPrefix(parsed.host)}${parsed.pathname}${parsed.search}`);
    } catch {
      // URL de source illisible : elle n'autorise rien.
    }
  }
  const candidates = [...text.matchAll(ABSOLUTE_URL)].map((match) => match[0]);
  for (const href of text.matchAll(HREF)) {
    const value = href[1] ?? href[2];
    if (value) candidates.push(value.replace(/&amp;/g, "&"));
  }
  const found: InformationAgentCommercialMention[] = [];
  for (const candidate of candidates) {
    let url: URL;
    try {
      url = new URL(candidate, appOrigin ?? "https://invalid.invalid");
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const host = withoutHostPrefix(url.host);
    const sourceKey = `${host}${url.pathname}${url.search}`;
    // La page source de l'adresse peut être citée avec ou sans fragment ni barre finale.
    const trimmedSourceKey = sourceKey.replace(/\/$/, "");
    const isAllowedSource = [...allowed].some(
      (value) => value === sourceKey || value.replace(/\/$/, "") === trimmedSourceKey,
    );
    const isAllowedApp =
      appHost !== null &&
      host === appHost &&
      ALLOWED_APP_PATHS.some((pattern) => pattern.test(url.pathname));
    const isAllowedExternal = ALLOWED_EXTERNAL_HOSTS.has(url.host.toLowerCase());
    if (!isAllowedSource && !isAllowedApp && !isAllowedExternal) {
      found.push({ rule: "link", excerpt: candidate });
    }
  }
  return found;
}

/**
 * Mentions commerciales d'un texte (gabarit, objet, corps, texte brut ou HTML rendu). Avec
 * `appOrigin`, les liens vers le site d'Immojudis sont limités à ses pages utiles ; tout autre lien
 * est refusé, hors plainte CNIL et URLs de `allowedUrls`.
 */
export function findInformationAgentCommercialMentions(
  text: string,
  options: InformationAgentCommercialGuardOptions = {},
): InformationAgentCommercialMention[] {
  let normalized = normalizeInformationAgentGuardText(text);
  for (const ignored of options.ignore ?? []) {
    const cleaned = ignored ? normalizeInformationAgentGuardText(ignored).trim() : "";
    if (cleaned) normalized = normalized.split(cleaned).join(" ");
  }
  // Les liens sont contrôlés sur le texte entier (attributs compris), les mots sur le texte visible.
  const links = linkMentions(normalized, options);
  const visible = ALLOWED_PHRASES.reduce(
    (current, pattern) => current.replace(pattern, " "),
    normalized.replace(/<[^>]+>/g, " "),
  );
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
  options: InformationAgentCommercialGuardOptions = {},
): void {
  const mentions = findInformationAgentCommercialMentions(text, options);
  if (mentions.length) {
    const list = [...new Set(mentions.map((mention) => `« ${mention.excerpt} »`))].slice(0, 5);
    throw new Error(
      `Le message ne doit contenir aucune mention commerciale (offre, compte, inscription, mise en avant, prix, partenariat, lien étranger au dossier) : ${list.join(", ")}.`,
    );
  }
}
