import type { ReviewReason } from "@/lib/information-agent-review-reasons";
import { unicodeWordBoundaries } from "@/lib/information-agent-inbound/unicode-boundaries";

/**
 * Lecture de la phrase qui porte une information tirée d'une réponse par les règles. Même contrôle que le
 * validateur de la lecture par l'IA (`services/data-pipeline/src/information_agent_review_signals.py`),
 * mêmes codes de motifs : rejet (négation de la valeur, autre lot), motifs de relecture (conditionnel,
 * approximation collée à la valeur, valeur rapportée ou comparée, réserve dans la phrase ou une voisine,
 * fourchette, correction, renvoi, question, lot), ou fait net.
 */

export type LotContext = {
  /** L'annonce compte plusieurs lots. */
  multiLot: boolean;
  /** Le lot vendu, quand l'annonce le désigne avec certitude. */
  soldLot?: { number: number; lotCount: number | null } | null;
};

export type StatementReview = { rejected: boolean; reasons: ReviewReason[] };

const NUMERIC_FACT_KEYS = new Set([
  "surface_m2",
  "land_surface_m2",
  "rooms_count",
  "starting_price_eur",
]);
const MIN_STATEMENT_CHARS = 25;

const u = (pattern: RegExp) => unicodeWordBoundaries(pattern);
const L = String.raw`\p{L}`;

// --- Phrases et propositions -------------------------------------------------------------------------
const ABBREVIATIONS_BEFORE_PERIOD = new Set([
  "env",
  "approx",
  "cf",
  "n",
  "no",
  "art",
  "m",
  "me",
  "mme",
  "mm",
  "st",
  "ste",
  "av",
  "bd",
  "p",
  "pp",
  "ch",
  "ref",
  "réf",
  "etc",
  "ex",
]);
const BULLET_RE = /^\s*(?:[-•*–·▪]|\d{1,2}[.)])\s+/u;
const LINE_START_SENTENCE_RE = /^\s*(?:[-•*–·▪(]|\d{1,2}[.)]\s|[A-ZÀ-ÖØ-Þ])/u;
const CLAUSE_SEPARATOR_RE = u(
  /(?<!\d),|,(?!\d)|;|\(|\)|\s[-–]\s|\b(?:et|mais|car|donc|puis|tandis\s+que|alors\s+que|or)\b/giu,
);

function splitSentences(text: string): Array<[number, number]> {
  const bounds: Array<[number, number]> = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    let end: number | null = null;
    if ("!?…".includes(character)) {
      end = index + 1;
      while (end < text.length && "!?…".includes(text[end]!)) end++;
    } else if (character === "." && periodEndsSentence(text, index)) {
      end = index + 1;
    } else if (character === "\n" && newlineEndsSentence(text, index)) {
      end = index;
    }
    if (end != null) {
      if (text.slice(start, end).trim()) bounds.push([start, end]);
      start = character === "\n" ? end + 1 : end;
      index = start;
      continue;
    }
    index++;
  }
  if (text.slice(start).trim()) bounds.push([start, text.length]);
  return bounds;
}

function periodEndsSentence(text: string, index: number): boolean {
  const before = text[index - 1] ?? "";
  const after = text[index + 1] ?? "";
  if (/\d/u.test(before) && /\d/u.test(after)) return false;
  if (after && !/\s/u.test(after)) return false;
  const word = /(\p{L}+)$/u.exec(text.slice(Math.max(0, index - 12), index));
  return !(word && ABBREVIATIONS_BEFORE_PERIOD.has(word[1]!.toLocaleLowerCase("fr-FR")));
}

function newlineEndsSentence(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const current = text.slice(lineStart, index);
  const rest = text.slice(index + 1);
  if (!rest.trim() || !current.trim()) return true;
  if (/^[ \t]*\n/u.test(rest)) return true;
  return BULLET_RE.test(current) || LINE_START_SENTENCE_RE.test(rest);
}

function clauseBounds(sentence: string, offset: number): [number, number] {
  let start = 0;
  let end = sentence.length;
  for (const match of sentence.matchAll(CLAUSE_SEPARATOR_RE)) {
    const matchStart = match.index ?? 0;
    const matchEnd = matchStart + match[0].length;
    if (matchEnd <= offset) start = matchEnd;
    else if (matchStart >= offset) {
      end = matchStart;
      break;
    }
  }
  return [start, end];
}

function clauses(sentence: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const match of sentence.matchAll(CLAUSE_SEPARATOR_RE)) {
    parts.push(sentence.slice(start, match.index ?? 0));
    start = (match.index ?? 0) + match[0].length;
  }
  parts.push(sentence.slice(start));
  return parts.filter((part) => part.trim());
}

// --- Repères (mêmes listes que le worker Python) ------------------------------------------------------
const CONDITIONAL_RE = u(
  new RegExp(
    String.raw`\b${L}{2,}(?:rait|raient)\b|\bsembl(?:e|ent|erait|eraient)\b|\ba\s+priori\b|\bprobablement\b|\bvraisemblablement\b|\bapparemment\b|\bpeut-[êe]tre\b|\bsans\s+doute\b|\bth[ée]oriquement\b|\bpr[ée]sum[ée]e?s?\b|\bsuppos[ée]e?s?\b`,
    "iu",
  ),
);
const APPROX_WORDS = String.raw`environ|env\.|approx(?:\.|imativement|imative)?|pr[èe]s\s+de|plus\s+de|moins\s+de|au\s+moins|au\s+plus|jusqu['’]\s*[àa]|de\s+l['’]ordre\s+de|autour\s+de|aux\s+alentours\s+de|plus\s+ou\s+moins|quelque|[àa]\s+peu\s+pr[èe]s|grosso\s+modo|~|≈|±|\+\s*\/\s*-|\+-`;
const APPROX_BEFORE_RE = new RegExp(String.raw`(?:${APPROX_WORDS})\s*(?:d['’]\s*)?$`, "iu");
const APPROX_AFTER_RE = new RegExp(
  String.raw`^\s*(?:m\s?[²2]|m[èe]tres?\s+carr[ée]s?|€|euros?|pi[èe]ces?)?\s*(?:habitables?|carrez)?\s*(?:environ|approx${L}*|±|\+\s*\/\s*-|\+-|~|≈|au\s+moins|au\s+maximum|maximum|minimum|ou\s+plus|et\s+plus|\+(?!\s*\d))`,
  "iu",
);
const APPROX_ANYWHERE_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:${APPROX_WORDS})`, "iu");
const SOURCE_INTRO_RE = u(/\b(?:selon|d['’]apr[èe]s|suivant)\b/giu);
const DOCUMENTARY_SOURCE_RE = u(
  /^\s*(?:(?:le|la|les|l['’]|notre|votre|un|une)\s*)?(?:titre|acte|certificat|attestation|mesurage|m[ée]tr(?:age|[ée])|diagnostic|dossier\s+de\s+diagnostic|cahier|proc[èe]s[-\s]verbal|pv|relev[ée]\s+de\s+g[ée]om[èe]tre)\b/iu,
);
const DATED_OR_OLD_RE = u(
  /\b(?:de|du|en|dat[ée]e?\s+de)\s+(?:\d{4}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4})\b|\b(?:ancien(?:ne)?s?|pr[ée]c[ée]dent(?:e)?s?)\b/iu,
);
const REPORTED_RE = u(
  new RegExp(
    String.raw`\bl['’]annonce\s+(?:indiqu|mentionn|pr[ée]cis|annon[cç]|parl|donn|affich)${L}*|\bl['’]annonce\s+fait\s+[ée]tat|\b(?:indiqu|mentionn|annonc|affich)[ée]e?s?\s+(?:dans|sur|par)\s+(?:l['’]annonce|le\s+site|internet|l['’]agence)|\bpour\s+comparaison\b|\bpar\s+comparaison\b|\b[àa]\s+titre\s+de\s+(?:comparaison|r[ée]f[ée]rence|exemple)\b|\bvoisin(?:e|s|es)?\b|\bcomparables?\b|\bje\s+reprends\b|\bon\s+m['’]a\s+(?:dit|indiqu[ée]|rapport[ée])|\bil\s+para[iî]t\b|\bde\s+m[ée]moire\b|\bsi\s+je\s+me\s+souviens\b`,
    "iu",
  ),
);
const PENDING_RE = u(
  new RegExp(
    String.raw`\b(?:sous\s+(?:toute\s+)?r[ée]serve|[àa]\s+(?:v[ée]rifier|confirmer|pr[ée]ciser|contr[ôo]ler)|non\s+(?:confirm|v[ée]rifi|contr[ôo]l|valid)${L}*|(?:pas|jamais)\s+(?:encore\s+)?(?:[ée]t[ée]\s+)?(?:contr[ôo]l|v[ée]rifi|mesur|confirm|valid)${L}*|[àa]\s+titre\s+indicatif|indicati(?:f|ve)s?|estimation|estim[ée]e?s?|provisoire)`,
    "iu",
  ),
);
const ERROR_RE = u(/\b(?:erreur|erron[ée]e?s?|inexacte?s?|faute\s+de\s+frappe|coquille)\b/iu);
const CORRECTION_RE = u(
  /\b(?:initialement|anciennement|pr[ée]c[ée]demment|ramen[ée]e?s?|baiss[ée]e?s?|abaiss[ée]e?s?|r[ée]duite?s?\s+[àa]|rectifi[ée]e?s?|corrig[ée]e?s?|au\s+lieu\s+de|par\s+erreur|pr[ée]c[ée]dent(?:e|s|es)?|ancien(?:ne|s|nes)?)\b/iu,
);
const POSTPONEMENT_RE = u(
  /\b(?:renvoy[ée]e?s?|renvoi|report[ée]e?s?|report|ajourn[ée]e?s?|d[ée]cal[ée]e?s?|remise?s?\s+(?:[àa]|au)\s+(?:une\s+)?(?:date|audience|plus\s+tard|\d))\b/iu,
);
const AMOUNT = String.raw`\d[\d\s.,]*(?:\s*(?:m\s?[²2]|m[èe]tres?\s+carr[ée]s?|€|euros?|pi[èe]ces?))?`;
const RANGE_RE = u(
  new RegExp(
    String.raw`\bentre\s+${AMOUNT}\s+et\s+\d|\bde\s+${AMOUNT}\s+[àa]\s+\d[\d\s.,]*(?!\s*(?:min|minutes?|km|kilom[èe]tres?|h\b|heures?|pas\b))|\d\s*(?:-|–|\/|[àa])\s*\d+(?:[.,]\d+)?\s*(?:m\s?[²2]|€|pi[èe]ces?)(?![\p{L}\p{N}_])`,
    "giu",
  ),
);
const NEIGHBOUR_REFERENCE_RE = u(
  /\b(?:ce|cet|cette|ces)\s+(?:chiffres?|surfaces?|superficies?|valeurs?|points?|informations?|mesures?|montants?|donn[ée]es?|dimensions?|prix|dates?|[ée]l[ée]ments?|indications?|m[ée]trages?)\b|\b(?:il|elle)\s+s['’]agit\b/iu,
);
const NEGATION_BEFORE_RE = u(
  /(?:\bn['’]|\bne\b)[^,;]{0,40}?\b(?:pas|plus|jamais|point)\b[^,;]{0,30}$|\b(?:aucun(?:e)?|pas\s+de|non\s+pas)\b[^,;]{0,30}$/iu,
);
const UNIT_KIND_RES: Record<string, RegExp> = {
  area: /\d\s*(?:m\s?[²2]|m[èe]tres?\s+carr[ée]s?)(?![\p{L}\p{N}_])/iu,
  money: /\d\s*(?:€|euros?)(?![\p{L}\p{N}_])/iu,
  rooms: u(/\d\s*pi[èe]ces?\b/iu),
};
const FACT_UNIT_KIND: Record<string, string> = {
  surface_m2: "area",
  land_surface_m2: "area",
  starting_price_eur: "money",
  rooms_count: "rooms",
};
const LOT_MENTION_RE = u(
  /\blots?\s*(?:n(?:°|o|os|um[ée]ros?)?\.?\s*)?(\d{1,3}(?:\s*(?:,|et|&|à|a|-)\s*\d{1,3})*)\b/giu,
);
const CO_OWNERSHIP_LOT_CONTEXT = /copropri[ée]t[ée]|[ée]tat\s+descriptif|tanti[èe]mes/iu;

function lotMentions(text: string, start: number, end: number): Array<[number, Set<number>]> {
  const mentions: Array<[number, Set<number>]> = [];
  const slice = text.slice(start, end);
  for (const match of slice.matchAll(LOT_MENTION_RE)) {
    const position = start + (match.index ?? 0);
    const around = text.slice(Math.max(0, position - 30), position + match[0].length + 30);
    if (CO_OWNERSHIP_LOT_CONTEXT.test(around)) continue;
    const numbers = new Set((match[1]?.match(/\d+/gu) ?? []).map(Number));
    if (numbers.size) mentions.push([position, numbers]);
  }
  return mentions;
}

function documentarySource(sentence: string, matchEnd: number): boolean {
  const rest = sentence.slice(matchEnd);
  if (!DOCUMENTARY_SOURCE_RE.test(rest)) return false;
  const clauseEnd = /[,;:]/u.exec(rest);
  const clause = clauseEnd ? rest.slice(0, clauseEnd.index) : rest.slice(0, 80);
  return !DATED_OR_OLD_RE.test(clause);
}

function reported(sentence: string): boolean {
  if (REPORTED_RE.test(sentence)) return true;
  return [...sentence.matchAll(SOURCE_INTRO_RE)].some(
    (match) => !documentarySource(sentence, (match.index ?? 0) + match[0].length),
  );
}

function otherUnitNumber(clause: string, factKey: string): boolean {
  const kind = FACT_UNIT_KIND[factKey];
  return Object.entries(UNIT_KIND_RES).some(
    ([name, pattern]) => name !== kind && pattern.test(clause),
  );
}

function rangeAt(
  sentence: string,
  clause: string,
  start: number,
  end: number,
  numeric: boolean,
): boolean {
  if (!numeric) return new RegExp(RANGE_RE.source, "iu").test(clause);
  return [...sentence.matchAll(RANGE_RE)].some((match) => {
    const matchStart = match.index ?? 0;
    return matchStart <= end && matchStart + match[0].length >= start;
  });
}

function sentenceIndexAt(sentences: Array<[number, number]>, position: number): number {
  const found = sentences.findIndex(([start, end]) => start <= position && position < end);
  if (found >= 0) return found;
  let best = 0;
  for (let index = 1; index < sentences.length; index++) {
    if (Math.abs(sentences[index]![0] - position) < Math.abs(sentences[best]![0] - position)) {
      best = index;
    }
  }
  return best;
}

/**
 * Rejet ou motifs de relecture pour la valeur située en `anchor` ([début, fin[) dans `text`. Pour une clé
 * numérique, `anchor` est la position du nombre. Le lot n'est contrôlé que si `lotContext` est donné
 * (`checkLot` à faux : contrôle reporté au moment où le contexte de la vente est lu).
 */
export function reviewStatement(
  text: string,
  anchor: [number, number],
  factKey: string,
  {
    lotContext = null,
    checkLot = true,
  }: { lotContext?: LotContext | null; checkLot?: boolean } = {},
): StatementReview {
  const sentences = splitSentences(text);
  if (!sentences.length) return { rejected: false, reasons: [] };
  const position = Math.min(Math.max(anchor[0], 0), text.length - 1);
  const index = sentenceIndexAt(sentences, position);
  const [sStart, sEnd] = sentences[index]!;
  const sentence = text.slice(sStart, sEnd);
  const previous = index > 0 ? text.slice(...sentences[index - 1]!) : "";
  const following = index + 1 < sentences.length ? text.slice(...sentences[index + 1]!) : "";
  const offset = position - sStart;
  const [cStart, cEnd] = clauseBounds(sentence, offset);
  const clause = sentence.slice(cStart, cEnd);
  const beforeValue = sentence.slice(cStart, offset);
  const afterValue = sentence.slice(Math.min(sentence.length, anchor[1] - sStart), cEnd);
  const numeric = NUMERIC_FACT_KEYS.has(factKey);

  if (numeric && NEGATION_BEFORE_RE.test(beforeValue)) return { rejected: true, reasons: [] };
  let lotReasons: ReviewReason[] = [];
  if (checkLot) {
    const lot = reviewLot(text, anchor, lotContext);
    if (lot.rejected) return { rejected: true, reasons: [] };
    lotReasons = lot.reasons;
  }

  const reasons: ReviewReason[] = [];
  if (sentence.replace(BULLET_RE, "").trim().length < MIN_STATEMENT_CHARS) {
    reasons.push("short_citation");
  }
  let hedged = CONDITIONAL_RE.test(clause);
  if (numeric) {
    hedged ||= APPROX_BEFORE_RE.test(beforeValue.slice(-40)) || APPROX_AFTER_RE.test(afterValue);
  } else {
    hedged ||= APPROX_ANYWHERE_RE.test(clause);
  }
  if (hedged) reasons.push("hedged_statement");
  if (reported(sentence)) reasons.push("reported_or_comparison");
  if (PENDING_RE.test(sentence) || PENDING_RE.test(previous) || PENDING_RE.test(following)) {
    reasons.push("pending_verification");
  }
  if (
    factKey !== "visit_information" &&
    factKey !== "sale_date" &&
    rangeAt(sentence, clause, offset, anchor[1] - sStart, numeric)
  ) {
    reasons.push("value_range");
  }
  const corrected =
    ERROR_RE.test(sentence) ||
    ERROR_RE.test(previous) ||
    ERROR_RE.test(following) ||
    [clause, ...clauses(sentence)].some(
      (part) => CORRECTION_RE.test(part) && (part === clause || !otherUnitNumber(part, factKey)),
    );
  if (corrected) reasons.push("corrected_or_stale_value");
  if (factKey !== "sale_date" && POSTPONEMENT_RE.test(sentence)) reasons.push("postponement");
  if (sentence.trimEnd().endsWith("?")) reasons.push("question");
  for (const neighbour of [previous, following]) {
    if (!NEIGHBOUR_REFERENCE_RE.test(neighbour)) continue;
    if (CONDITIONAL_RE.test(neighbour) || APPROX_ANYWHERE_RE.test(neighbour)) {
      reasons.push("hedged_statement");
    }
    if (reported(neighbour)) reasons.push("reported_or_comparison");
    if (CORRECTION_RE.test(neighbour)) reasons.push("corrected_or_stale_value");
  }
  reasons.push(...lotReasons);
  return { rejected: false, reasons: [...new Set(reasons)] };
}

/** Contrôle du lot : le lot nommé le plus proche avant la valeur (phrase précédente comprise). */
export function reviewLot(
  text: string,
  anchor: [number, number],
  lotContext: LotContext | null,
): StatementReview {
  const sentences = splitSentences(text);
  if (!sentences.length) return { rejected: false, reasons: [] };
  const position = Math.min(Math.max(anchor[0], 0), text.length - 1);
  const index = sentenceIndexAt(sentences, position);
  const [sStart, sEnd] = sentences[index]!;
  const sold = lotContext?.soldLot ?? null;
  const highest = sold?.lotCount ?? 9;
  const inRange = (numbers: Set<number>) =>
    new Set([...numbers].filter((number) => number >= 1 && number <= highest));
  const windowStart = index > 0 ? sentences[index - 1]![0] : sStart;
  const before = lotMentions(text, windowStart, position)
    .map(([, numbers]) => inRange(numbers))
    .filter((numbers) => numbers.size);
  const nearest = before.at(-1) ?? null;
  const inSentence = inRange(
    new Set(lotMentions(text, sStart, sEnd).flatMap(([, numbers]) => [...numbers])),
  );
  const named = nearest ?? inSentence;
  const pageLots = inRange(
    new Set(lotMentions(text, 0, text.length).flatMap(([, numbers]) => [...numbers])),
  );

  if (sold) {
    if (nearest) return { rejected: !nearest.has(sold.number), reasons: [] };
    if (inSentence.size && !inSentence.has(sold.number)) return { rejected: true, reasons: [] };
    return { rejected: false, reasons: inSentence.size ? [] : ["lot_unidentified"] };
  }
  if (lotContext?.multiLot) {
    return { rejected: false, reasons: [named.size ? "lot_unverified" : "lot_unidentified"] };
  }
  if ([...named].some((number) => number !== 1)) {
    return { rejected: false, reasons: ["lot_unverified"] };
  }
  if (pageLots.size > 1) return { rejected: false, reasons: ["lot_unidentified"] };
  return { rejected: false, reasons: [] };
}
