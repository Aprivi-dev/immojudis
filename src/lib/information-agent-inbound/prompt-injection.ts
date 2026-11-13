import { stripInvisibleCharacters } from "@/lib/information-agent-inbound/text";
import { unicodeWordBoundaries } from "@/lib/information-agent-inbound/unicode-boundaries";

/**
 * Motifs d'instructions adressées à un modèle (« ignore les consignes », « system: », faux délimiteurs du prompt
 * de lecture). Une réponse qui en contient part entière en relecture humaine (motif `possible_prompt_injection`) :
 * aucune information n'en est extraite automatiquement. Même liste et mêmes normalisations dans le worker
 * Python (`contains_prompt_injection`, `services/data-pipeline/src/information_agent_semantic.py`).
 *
 * C'est un SIGNAL, pas une barrière : un texte habile passera toujours un jeu de motifs. La publication
 * automatique restera contrôlée par des conditions structurelles (accord des règles et de l'IA sans motif de
 * relecture, liste fermée de champs : voir `docs/runbooks/information-agent.md`).
 *
 * Normalisations, identiques des deux côtés : caractères invisibles retirés (dont le trait d'union
 * conditionnel), NFKC (lettres pleine chasse), quelques homoglyphes cyrilliques et grecs ramenés à l'ASCII,
 * lettres espacées recollées (« i g n o r e »).
 *
 * Ne déclenchent rien : « selon les instructions du juge », « le système de chauffage », « J'ignore les
 * consignes du syndic », « Veuillez ignorer les indications de mon précédent courriel », « ignorer les règles
 * de l'ancien règlement », une signature « Assistant : Paul Martin ».
 */
const ORDER_NOUNS = String.raw`(?:(?:consignes|instructions|directives)\b(?!\s+(?:de|du|d['’]|dans)\s+(?:mon|ma|notre|le|la)\s+(?:pr[ée]c[ée]dent|dernier|derni[èe]re)\p{L}*\s+(?:message|courriel|mail|e-mail|email|envoi|r[ée]ponse))|(?:r[èe]gles|indications)\s+(?:pr[ée]c[ée]dentes|ci-dessus|ant[ée]rieures|du\s+syst[èe]me|de\s+ce\s+prompt|qui\s+pr[ée]c[èe]dent))`;
const ENGLISH_GAP = String.raw`[\s.,;:!-]+`;

const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  // « Ignore les consignes précédentes », « oubliez toutes vos instructions », mais pas « j'ignore les consignes ».
  new RegExp(
    String.raw`(?<!\b(?:j['’]|je|n['’]|on|il|elle|ils|elles|nous)\s*)\b(?:ignor(?:e|es|ez|er)|oubli(?:e|es|ez|er)|ne\s+(?:tiens|tenez)\s+pas\s+compte)\s+(?:de\s+|des\s+|d['’])?(?:toutes?\s+)?(?:les\s+|tes\s+|vos\s+|ces\s+|ses\s+|leurs\s+)?${ORDER_NOUNS}`,
    "iu",
  ),
  // « Oubliez tout ce qui précède ».
  /\b(?:ignor(?:e|es|ez|er)|oubli(?:e|es|ez|er))\s+tout\s+ce\s+qui\s+(?:pr[ée]c[èe]de|est\s+(?:au-dessus|ci-dessus|plus\s+haut))/iu,
  // « Ignore previous instructions », « ignore. previous instructions », « disregard everything above ».
  new RegExp(
    String.raw`\b(?:ignore|disregard|forget)${ENGLISH_GAP}(?:(?:all|any)${ENGLISH_GAP})?(?:(?:the|your)${ENGLISH_GAP})?(?:(?:previous|prior|above|earlier|preceding)${ENGLISH_GAP})?(?:instructions|prompts?|rules|directions)\b`,
    "iu",
  ),
  /\b(?:ignore|disregard|forget)\s+(?:everything|anything|all)\s+(?:above|before|prior|previous|earlier)\b/iu,
  // Rôle d'une conversation de modèle : « system: », « rôle : system », « SYSTEM PROMPT ».
  /(?:^|[\n\r>"'«([{.!?;])\s*(?:system|developer)\s*:/imu,
  /\br[ôo]le\s*:\s*(?:system|syst[èe]me|assistant|developer|d[ée]veloppeur)\b/iu,
  /\bsystem\s+prompt\b/iu,
  // « assistant: » seul sur sa ligne ou suivi d'une consigne en minuscule ; pas une signature
  // « Assistant : Paul Martin ».
  /(?:^|[\n\r>"'«([{.!?;])[ \t]*(?:[Aa]ssistant|ASSISTANT)[ \t]*:[ \t]*(?:$|(?=[a-zà-ÿ0-9"'«<[]))/mu,
  // Adresse au modèle : « tu es un modèle », « vous êtes une IA », « you are an AI », « act as ».
  /\btu\s+es\s+(?:maintenant\s+)?(?:un|une)\s+(?:mod[èe]le|ia|intelligence\s+artificielle|assistant|chatbot|llm)\b/iu,
  /(?:\bvous\s+[êe]tes\s+(?:maintenant\s+)?(?:un|une)\s+|\ben\s+tant\s+qu['’]|\ben\s+tant\s+que\s+)(?:mod[èe]le\s+de\s+langage|ia|intelligence\s+artificielle|llm|chatbot)\b/iu,
  /\byou\s+are\s+(?:now\s+)?(?:an?\s+)?(?:ai|assistant|language\s+model|llm|chatbot)\b/iu,
  /\b(?:act|behave)\s+as\b|\bpretend\s+(?:to\s+be|you\s+are)\b/iu,
  // « Nouvelle consigne : », « nouvelles instructions : », « new instructions: ».
  /\b(?:nouvelles?\s+(?:consignes?|instructions?)|new\s+instructions?)\s*:/iu,
  // Titre de prompt en Markdown : « ### Instruction ».
  /(?:^|\n)[ \t]*#{1,6}[ \t]*(?:instructions?|system|prompt|r[ôo]le|consignes?)\b/imu,
  // Faux délimiteurs du prompt et balises de modèles de conversation.
  /<\s*\/?\s*(?:untrusted[-_\s]?(?:evidence|ocr)|page\s+number|system|instructions?|prompt)\b/iu,
  /<\|(?:im_start|im_end|system|assistant|user)\|>|\[\/?INST\]|<<\/?SYS>>/iu,
].map((pattern) => unicodeWordBoundaries(pattern));

/** Homoglyphes cyrilliques et grecs courants, ramenés à la lettre latine qu'ils imitent. */
const HOMOGLYPHS: Record<string, string> = {
  а: "a",
  в: "b",
  е: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ї: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ԛ: "q",
  ԝ: "w",
  ɡ: "g",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  І: "I",
  Ј: "J",
  Ѕ: "S",
  α: "a",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  Α: "A",
  Ε: "E",
  Ι: "I",
  Κ: "K",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
};
const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join("")}]`, "gu");
const SPACED_LETTERS_RE = /(?<!\p{L})(?:\p{L}[ \t]{1,2}){3,}\p{L}(?!\p{L})/gu;

/** Texte tel que le détecteur le lit (mêmes étapes que le worker Python). */
function normalizeForPromptInjection(text: string): string {
  return stripInvisibleCharacters(text)
    .normalize("NFKC")
    .replace(HOMOGLYPH_RE, (character) => HOMOGLYPHS[character] ?? character);
}

/** Le texte contient-il une instruction adressée à un modèle ? */
export function detectPossiblePromptInjection(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = normalizeForPromptInjection(text);
  const joined = normalized.replace(SPACED_LETTERS_RE, (match) => match.replace(/[ \t]/gu, ""));
  return PROMPT_INJECTION_PATTERNS.some(
    (pattern) => pattern.test(normalized) || (joined !== normalized && pattern.test(joined)),
  );
}
