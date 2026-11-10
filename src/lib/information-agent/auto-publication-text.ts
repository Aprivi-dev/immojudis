/**
 * Détecteurs de texte du moteur « publier ou relire » (module pur). Ils lisent l'objet et le corps d'une
 * réponse pour y trouver une demande de ne pas publier ou le nom d'un particulier. Logique FERMÉE : un faux
 * positif ne coûte qu'une relecture, un faux négatif pourrait coûter une publication. Le texte n'est jamais
 * conservé ni journalisé.
 *
 * LIMITE : ce sont des motifs. Ils ne peuvent pas être exhaustifs ; ils sont une première ligne. Avant tout
 * mode automatique (étape 6), il faudra un signal de la lecture par l'IA et une famille « ne pas publier »
 * dans le jeu d'évaluation (étape 4).
 *
 * Découpage en mots par les classes Unicode (lettres et chiffres), comme `reply-intent.ts` : « n’autorise »
 * donne « n » et « autorise », « don't » donne « don » et « t ».
 */

/** Chiffres utilisés à la place de lettres (« C0NFIDENTIEL »), dans un mot qui contient aussi des lettres. */
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" };

/**
 * Mots normalisés : NFKC, minuscules, césures simples recollées (« pub-lier », « pub­lier »), lettres
 * isolées recollées (« N e p a s p u b l i e r » donne « nepaspublier »), chiffres à la place de lettres
 * ramenés aux lettres.
 */
function words(text: string): string[] {
  const joined = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(\p{L})[-­]\s*(\p{L})/gu, "$1$2");
  const raw = joined.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const tokens: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 4) tokens.push(run.join(""));
    else tokens.push(...run);
    run = [];
  };
  for (const token of raw) {
    const plain =
      /\p{L}/u.test(token) && /\d/.test(token)
        ? token.replace(/[013457]/g, (digit) => LEET[digit] ?? digit)
        : token;
    if ([...plain].length === 1 && /\p{L}/u.test(plain)) {
      run.push(plain);
      continue;
    }
    flush();
    tokens.push(plain);
  }
  flush();
  return tokens;
}

/** Mots de négation ou de restriction (français et anglais). */
const NEGATIONS = new Set([
  "ne",
  "n",
  "pas",
  "sans",
  "non",
  "jamais",
  "aucun",
  "aucune",
  "ni",
  "rien",
  "nullement",
  "not",
  "no",
  "don",
  "never",
]);

/** Racines de publication ou de communication (un mot). */
const COMMUNICATION_ROOT_RE =
  /^(?:publi|diffus|divulg|communiquer$|communiquez$|partager$|partagez$|reprendre$|reprenez$|reprodui|relay|afficher$|affichez$|figurer$|utiliser$|utilisez$|share|disclos|post$|posted$|posting$|autoris)/u;
/** Racines de communication de deux mots (« en ligne », « rendre public », « faire état »). */
const COMMUNICATION_PAIRS: Array<[string, RegExp]> = [
  ["en", /^ligne$/u],
  ["rendre", /^publi/u],
  ["faire", /^état$/u],
  ["fasse", /^état$/u],
];
/** Racines de refus, comptées sans négation quand une racine de communication est proche. */
const REFUSAL_ROOT_RE = /^(?:refus|oppos|interdi|absten|abstien|retir|embargo|secret|discr)/u;
/** Mots qui, à eux seuls, demandent de ne pas publier. */
const STANDALONE_WORD_RE =
  /^(?:confidentiel(?:le)?s?|confidential|embargo|secr[eè]t(?:e|s|es)?|discr[eè]t(?:e|s|es)?|discr[ée]tion)$/u;
/** Formes recollées (lettres isolées, mots attachés). */
const COMPACT_RE =
  /(?:^|ne|n)pas(?:publi|diffus|divulg|communiq|partag|reprend|reprodu)|confidenti(?!alit)|donotpublish|offtherecord/u;
/** « interne » ne compte qu'avec un de ces mots à proximité (« usage interne », « note interne »). */
const INTERNAL_CONTEXT = new Set([
  "usage",
  "strictement",
  "document",
  "documents",
  "note",
  "notes",
  "diffusion",
]);
/** Expressions sur le texte normalisé (mots séparés par une espace). */
const PHRASE_RES = [
  /\boff the record\b/u,
  /\bpour votre information uniquement\b/u,
  /\bpour votre seule information\b/u,
  /\b(?:a|à) votre (?:seul )?usage\b/u,
  /\bstrictement personnel(?:le)?s?\b/u,
  /\bpour vous seule?s?\b/u,
  /\b(?:garder|gardez|conserver|conservez|garde|garderez)\b(?: \S+){0,5} pour vous\b/u,
  /\bsous le sceau\b/u,
];
/** Distance maximale (en mots) entre une négation ou un refus et une racine de communication. */
const WINDOW = 6;

function near(tokens: string[], index: number, length: number, test: (token: string) => boolean) {
  const before = tokens.slice(Math.max(0, index - WINDOW), index);
  const after = tokens.slice(index + length, index + length + WINDOW);
  return { before: before.some(test), after: after.some(test) };
}

function isCommunicationAt(tokens: string[], index: number): number {
  const token = tokens[index]!;
  if (COMMUNICATION_ROOT_RE.test(token)) return 1;
  const next = tokens[index + 1];
  if (
    next !== undefined &&
    COMMUNICATION_PAIRS.some(([first, second]) => token === first && second.test(next))
  ) {
    return 2;
  }
  return 0;
}

/**
 * Demande de ne pas publier : négation proche d'une racine de communication (« ne doit pas être publiée »,
 * « do not disclose »), refus proche d'une racine de communication (« je m'oppose à toute publication »,
 * « diffusion interdite »), mot qui suffit seul (« confidentiel », « secret », « embargo », « discret »),
 * « interne » avec « usage », « strictement », « note »… et expressions (« off the record », « pour votre
 * information uniquement », « gardez-la pour vous », « strictement personnel »).
 */
export function mentionsDoNotPublish(text: string): boolean {
  const tokens = words(text);
  if (PHRASE_RES.some((pattern) => pattern.test(tokens.join(" ")))) return true;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (STANDALONE_WORD_RE.test(token) || COMPACT_RE.test(token)) return true;
    if (
      /^internes?$/u.test(token) &&
      tokens.slice(Math.max(0, index - 3), index + 4).some((other) => INTERNAL_CONTEXT.has(other))
    ) {
      return true;
    }
    const length = isCommunicationAt(tokens, index);
    if (!length) continue;
    const negated = near(tokens, index, length, (other) => NEGATIONS.has(other));
    // Une négation ne compte qu'avant la racine ou juste après (« ne la publiez pas »).
    const negatedAfter = tokens
      .slice(index + length, index + length + 2)
      .some((other) => NEGATIONS.has(other));
    if (negated.before || negatedAfter) return true;
    const refused = near(tokens, index, length, (other) => REFUSAL_ROOT_RE.test(other));
    if (refused.before || refused.after) return true;
  }
  return false;
}

/** Civilités et désignations de particuliers, sans « Maître » ni « Me » (l'avocat signe). */
const CIVILITY_RE =
  /(?<![\p{L}\p{N}])(m|mm|mr|mrs|mme|mmes|mlle|mlles|monsieur|madame|mademoiselle|époux|epoux|consorts|veuve|succession|indivision|héritiers|heritiers|famille)(?![\p{L}\p{N}])(\.?)/giu;
/** Après une civilité, ces mots ne sont pas des noms (« Monsieur le Président »). */
const NOT_A_NAME = new Set([
  "le",
  "la",
  "les",
  "l",
  "un",
  "une",
  "des",
  "et",
  "ou",
  "votre",
  "notre",
  "mon",
  "ma",
  "ce",
  "cette",
  "à",
  "a",
]);
const FULL_CIVILITIES = new Set(["monsieur", "madame", "mademoiselle"]);
/** Civilités après lesquelles un nom en minuscules compte (« Mme martin », « M. martin »). */
const LOWERCASE_NAME_AFTER = new Set([
  "monsieur",
  "madame",
  "mademoiselle",
  "mme",
  "mmes",
  "mlle",
  "mlles",
]);
/** Rôles qui désignent un particulier quand un prénom et un nom suivent (« le locataire Jean Dupont »). */
const ROLE_RE =
  /(?<![\p{L}\p{N}])(?:d[ée]biteurs?|d[ée]bitrices?|saisie?s?|locataires?|occupant(?:e|s|es)?|propri[ée]taires?|vendeur(?:s)?|vendeuses?|venderesses?)(?![\p{L}\p{N}])/giu;
const ROLE_NAME_RE =
  /^(?:[\s,:;«»"()–-]+|saisie?s?(?![\p{L}])|actuel(?:le)?s?(?![\p{L}]))*(\p{Lu}[\p{Ll}'’-]+)[ \t\u00a0]+(\p{Lu}[\p{L}'’-]+)/u;

/**
 * Nom d'un particulier :
 * - civilité (casse indifférente) suivie d'un nom : « M. Martin », « M.Martin », « M DUPONT », « Mr Martin »,
 *   « Mme Durand », « les époux Leroy », « famille Bernard ». Le nom commence par une majuscule ; une
 *   minuscule compte après une civilité en toutes lettres, « Mme », « Mlle », ou une abréviation avec point
 *   (« M. martin »), sauf article (« Monsieur le Président ») ;
 * - rôle suivi d'un prénom et d'un nom en majuscule initiale : « débiteur saisi : Pierre Durand »,
 *   « le locataire Jean Dupont », « le débiteur, Jean Martin, occupe ».
 * Ne comptent pas : « Madame, Monsieur, », « 54 m² », « 12 m de façade », « le locataire a quitté les
 * lieux ». « Le propriétaire Immobilière du Nord » ne déclenche rien (deuxième mot en minuscule) ; une
 * raison sociale de deux mots en majuscule initiale partirait en relecture, ce qui est acceptable.
 */
export function namesPrivatePerson(text: string): boolean {
  const normalized = text.normalize("NFKC");
  for (const match of normalized.matchAll(CIVILITY_RE)) {
    const civility = match[1]!.toLowerCase();
    const dotted = match[2] === ".";
    const rest = normalized.slice(match.index + match[0].length);
    // Une espace (pas une virgule, pas « ² »), ou rien après un point, un éventuel « de », « du » ou
    // « d’ », puis le nom.
    const name = (dotted ? /^[ \t\u00a0]*/u : /^[ \t\u00a0]+/u).exec(rest);
    if (!name) continue;
    const after = /^(?:(?:de|du|d['’])[ \t\u00a0]*)?([\p{L}][\p{L}'’-]*)/u.exec(
      rest.slice(name[0].length),
    );
    if (!after) continue;
    const word = after[1]!;
    // « Madame Monsieur » : une civilité qui en suit une autre n'est pas un nom.
    if (FULL_CIVILITIES.has(word.toLowerCase())) continue;
    if (/^\p{Lu}/u.test(word)) return true;
    const lowercaseAllowed =
      LOWERCASE_NAME_AFTER.has(civility) || (dotted && ["m", "mm", "mr", "mrs"].includes(civility));
    if (lowercaseAllowed && !NOT_A_NAME.has(word.toLowerCase())) return true;
  }
  for (const match of normalized.matchAll(ROLE_RE)) {
    if (ROLE_NAME_RE.test(normalized.slice(match.index + match[0].length))) return true;
  }
  return false;
}
