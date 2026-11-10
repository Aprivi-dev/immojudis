/**
 * Détecteurs de texte du moteur « publier ou relire » (module pur). Ils lisent l'objet et le corps d'une
 * réponse pour y trouver une demande de ne pas publier ou le nom d'un particulier. Logique FERMÉE : un faux
 * positif ne coûte qu'une relecture, un faux négatif pourrait coûter une publication. Le texte n'est jamais
 * conservé ni journalisé.
 *
 * Découpage en mots par les classes Unicode (lettres et chiffres), comme `reply-intent.ts` : « n’autorise »
 * donne « n » et « autorise », « don't » donne « don » et « t ».
 */

function words(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
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

/**
 * Mots qui, à eux seuls, signalent une information à ne pas publier : « confidentiel(le)(s) », « interne(s) ».
 * « Confidentialité » (« politique de confidentialité ») et « internet » ne comptent pas.
 */
const STANDALONE_WORD_RE = /^(?:confidentiel(?:le)?s?|internes?)$/u;
/** Racines d'un mot unique, retenues quand une négation les précède de peu. */
const NEGATED_ROOTS = ["publi", "diffus", "divulg", "autoris"];
/** Racines de deux mots (« en ligne », « rendre public », « faire état »). */
const NEGATED_PAIRS: Array<[string, string]> = [
  ["en", "ligne"],
  ["rendre", "public"],
  ["rendre", "publique"],
  ["faire", "état"],
  ["fasse", "état"],
];
/** Distance maximale (en mots) entre la négation et la racine. */
const NEGATION_WINDOW = 6;

function negatedAt(tokens: string[], index: number, length: number): boolean {
  const before = tokens.slice(Math.max(0, index - NEGATION_WINDOW), index);
  const after = tokens.slice(index + length, index + length + 2);
  return [...before, ...after].some((token) => NEGATIONS.has(token));
}

/**
 * « Ne pas publier » et variantes : « ne doit pas être publiée », « ne doivent pas être diffusés »,
 * « je n’autorise pas la diffusion », « ne pas en faire état », « ne pas la rendre publique », « ne pas
 * mettre en ligne », « sans publication », « please do not publish », « confidentiel », « usage interne ».
 */
export function mentionsDoNotPublish(text: string): boolean {
  const tokens = words(text);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (STANDALONE_WORD_RE.test(token)) return true;
    if (NEGATED_ROOTS.some((root) => token.startsWith(root)) && negatedAt(tokens, index, 1)) {
      return true;
    }
    const next = tokens[index + 1];
    if (
      next !== undefined &&
      NEGATED_PAIRS.some(([first, second]) => token === first && next === second) &&
      negatedAt(tokens, index, 2)
    ) {
      return true;
    }
  }
  return false;
}

/** Civilités et désignations de particuliers, sans « Maître » ni « Me » (l'avocat signe). */
const CIVILITY_RE =
  /(?<![\p{L}\p{N}])(m|mm|mr|mrs|mme|mmes|mlle|mlles|monsieur|madame|mademoiselle|époux|epoux|consorts|veuve|succession|indivision|héritiers|heritiers|famille)(?![\p{L}\p{N}])\.?/giu;
/** Après une civilité écrite en toutes lettres, ces mots ne sont pas des noms (« Monsieur le Président »). */
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

/**
 * Nom d'un particulier : civilité (casse indifférente) suivie d'un nom (« M. Martin », « M DUPONT »,
 * « Mr Martin », « Mme Durand », « les époux Leroy », « famille Bernard », « monsieur martin »). Le nom
 * commence par une majuscule, sauf après une civilité en toutes lettres où tout mot qui n'est pas un article
 * compte. Ne comptent pas : « Madame, Monsieur, », « Monsieur le Président », « 54 m² », « 12 m de façade ».
 */
export function namesPrivatePerson(text: string): boolean {
  const normalized = text.normalize("NFKC");
  for (const match of normalized.matchAll(CIVILITY_RE)) {
    const civility = match[1]!.toLowerCase();
    const rest = normalized.slice(match.index + match[0].length);
    // Une espace (pas une virgule, pas « ² »), un éventuel « de », « du » ou « d’ », puis le nom.
    const name = /^[ \t\u00a0]+(?:(?:de|du|d['’])[ \t\u00a0]*)?([\p{L}][\p{L}'’-]*)/u.exec(rest);
    if (!name) continue;
    const word = name[1]!;
    // « Madame Monsieur » : une civilité qui en suit une autre n'est pas un nom.
    if (FULL_CIVILITIES.has(word.toLowerCase())) continue;
    if (/^\p{Lu}/u.test(word)) return true;
    if (FULL_CIVILITIES.has(civility) && !NOT_A_NAME.has(word.toLowerCase())) return true;
  }
  return false;
}
