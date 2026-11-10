import { unicodeWordBoundaries } from "@/lib/information-agent-inbound/unicode-boundaries";

/**
 * Motifs d'instructions adressées à un modèle (« ignore les consignes », « system: », faux délimiteurs du prompt
 * de lecture). Une réponse qui en contient part entière en relecture humaine (motif `possible_prompt_injection`) :
 * aucune information n'en est extraite automatiquement. Même liste dans le worker Python
 * (`PROMPT_INJECTION_RE`, `services/data-pipeline/src/information_agent_semantic.py`).
 *
 * Un avocat qui écrit « selon les instructions du juge », « conformément aux consignes de sécurité » ou « le
 * système de chauffage » ne déclenche rien : seul l'ordre d'ignorer des consignes, un rôle suivi de deux-points,
 * une adresse au modèle ou une balise de prompt comptent. « J'ignore les consignes du syndic » non plus.
 */
const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  // « Ignore les consignes précédentes », « oubliez toutes vos instructions », mais pas « j'ignore les consignes ».
  /(?<!\b(?:j['’]|je|n['’]|on|il|elle|ils|elles|nous)\s*)\b(?:ignor(?:e|es|ez|er)|oubli(?:e|es|ez|er)|ne\s+(?:tiens|tenez)\s+pas\s+compte)\s+(?:de\s+|des\s+|d['’])?(?:toutes?\s+)?(?:les\s+|tes\s+|vos\s+|ces\s+|ses\s+|leurs\s+)?(?:consignes|instructions|r[èe]gles|directives|indications)\b/iu,
  // « Ignore previous instructions », « disregard all prior instructions ».
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous\s+|prior\s+|above\s+|earlier\s+|preceding\s+)?(?:instructions|prompts?|rules|directions)\b/iu,
  // Rôle d'une conversation de modèle suivi de deux-points (« system: », « assistant: »).
  /(?:^|[\n\r>"'«([{.!?;])\s*(?:system|assistant|developer)\s*:/imu,
  // Adresse au modèle : « tu es un modèle », « vous êtes une IA », « you are an AI ».
  /\btu\s+es\s+(?:maintenant\s+)?(?:un|une)\s+(?:mod[èe]le|ia|intelligence\s+artificielle|assistant|chatbot|llm)\b/iu,
  /(?:\bvous\s+[êe]tes\s+(?:maintenant\s+)?(?:un|une)\s+|\ben\s+tant\s+qu['’]|\ben\s+tant\s+que\s+)(?:mod[èe]le\s+de\s+langage|ia|intelligence\s+artificielle|llm|chatbot)\b/iu,
  /\byou\s+are\s+(?:now\s+)?(?:an?\s+)?(?:ai|assistant|language\s+model|llm|chatbot)\b/iu,
  /\b(?:nouvelles?\s+(?:consignes|instructions)|new\s+instructions)\s*:/iu,
  // Faux délimiteurs du prompt et balises de modèles de conversation.
  /<\s*\/?\s*(?:untrusted-evidence|untrusted-ocr|page\s+number|system|instructions?|prompt)\b/iu,
  /<\|(?:im_start|im_end|system|assistant|user)\|>|\[\/?INST\]|<<\/?SYS>>/iu,
].map((pattern) => unicodeWordBoundaries(pattern));

/** Le texte contient-il une instruction adressée à un modèle ? */
export function detectPossiblePromptInjection(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text.normalize("NFC").replace(/[\u200b-\u200f\u2060\ufeff]/g, "");
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}
