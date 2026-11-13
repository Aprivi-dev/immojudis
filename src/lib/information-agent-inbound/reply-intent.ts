import "server-only";
import { normalizeEmail, replyTextForExtraction } from "@/lib/information-agent-inbound/text";
import { unicodeWordBoundaries } from "@/lib/information-agent-inbound/unicode-boundaries";
import { UUID_SOURCE } from "@/lib/uuid";

export function findInboundToken(
  addresses: readonly string[],
  inboundDomain: string,
): string | null {
  const tokens = collectInboundTokens(addresses, inboundDomain);
  return tokens.length === 1 ? tokens[0] : null;
}

const CONTACT_VERB = String.raw`(?:re)?(?:contacter|[ée]crire|solliciter|relancer|d[ée]marcher|d[ée]ranger|harceler|envoyer|adresser)`;
const CONTACT_NOUN = String.raw`(?:envois|messages?|courriels?|e-?mails?|mails?|sollicitations?|relances?|d[ée]marchages?|courriers?)`;

/**
 * Demandes explicites de ne plus être contacté : elles valent opposition sans relecture. Une
 * opposition manquée est plus grave qu'une opposition de trop (art. 21 RGPD). Les `\b` sont
 * réécrits en frontières Unicode (voir `unicode-boundaries.ts`).
 */
const STRICT_OPT_OUT_PATTERNS: RegExp[] = [
  // « STOP » seul sur une ligne, ou suivi d'une formule courte.
  /(?:^|\n)\s*(?:stop|unsubscribe|désinscription|desinscription)(?:[\s,]+merci)?\s*[.!…]*\s*$/imu,
  /(?:^|\n)\s*stop(?:\s*[.!,;:…-]+|\s+(?:svp|s['’]il\s+vous\s+pla[iî]t|merci|please|aux\s+(?:mails|e-?mails|messages|courriels|d[ée]marchages|sollicitations|relances)|[àa]\s+(?:vos|ces)\s+\p{L}+))/imu,
  // Formules courantes, quelle que soit la politesse qui les précède (« Veuillez », « Je vous
  // demande de »…), avec « jamais », « re- » ou « m'envoyer ».
  new RegExp(
    String.raw`\bne\s+plus\s+(?:jamais\s+)?(?:me|nous|m['’]|n['’])\s*${CONTACT_VERB}\b|\bne\s+plus\s+(?:jamais\s+)?(?:me|nous)\s+adresser\s+(?:de|vos)\b`,
    "iu",
  ),
  new RegExp(
    String.raw`\bne\s+(?:m['’]|nous\s+|me\s+)\s*(?:re)?(?:[ée]crivez|contactez|sollicitez|relancez|d[ée]marchez|d[ée]rangez|harcelez|envoyez)\s+(?:plus|jamais)\b|\bn['’](?:[ée]crivez|envoyez)\s+plus\b`,
    "iu",
  ),
  // « Arrêtez de m'écrire », « cessez vos envois », « stoppez ces mails ».
  new RegExp(
    String.raw`\b(?:arr[êe]tez|cessez|stoppez)\s+(?:de\s+(?:me|nous|m['’])\s*${CONTACT_VERB}|(?:vos|ces|les)\s+${CONTACT_NOUN})\b`,
    "iu",
  ),
  // « Veuillez cesser … contact / envois », « je vous prie d'arrêter de … ».
  new RegExp(
    String.raw`\b(?:veuillez|merci\s+de|je\s+vous\s+(?:prie|demande)\s+(?:de|d['’]))\s*(?:cesser|arr[êe]ter|stopper)\b[^.!?\n]{0,60}?(?:contact|${CONTACT_NOUN.slice(3, -1)}|sollicit|relance|d[ée]march)`,
    "iu",
  ),
  /\bje\s+vous\s+interdis\s+de\s+(?:me|nous)\s+(?:contacter|[ée]crire|solliciter|relancer)\b/iu,
  // Désinscription, y compris au milieu d'une phrase.
  /\bje\s+(?:me\s+)?d[ée]sabonne\b|\bd[ée]sabonnez[-\s]?(?:moi|nous)\b|\bd[ée]sinscrivez[-\s]?(?:moi|nous)\b|\b(?:me|nous)\s+d[ée]sinscrire\b|\b(?:ma|notre)\s+d[ée]sinscription\b|\bdemande\s+de\s+d[ée]sinscription\b|\bunsubscribe\s+(?:me|us)\b/iu,
  // Retrait des listes et du fichier.
  /\b(?:retirez|retirer|supprimez|supprimer|effacez|effacer|enlevez|enlever|radiez|radier)[-\s]*(?:moi|nous)\b/iu,
  /\b(?:retirez|retirer|supprimez|supprimer|effacez|effacer|enlevez|enlever|radiez|radier)\s+(?:mon|ma|mes|notre|nos)\s+(?:adresse|e-?mail|mail|courriel|coordonn[ée]es|contact|donn[ée]es)\b/iu,
  /\b(?:me|nous)\s+(?:retirer|supprimer|enlever|radier)\s+(?:de|d['’])\s*(?:votre|vos|la|toute|tout|l['’])/iu,
  // « Je ne souhaite plus … » : être contacté, sollicité, démarché, recevoir vos messages ou rien.
  /\bje\s+ne\s+(?:souhaite|veux|d[ée]sire|tiens)\s+plus\s+(?:[êe]tre\s+(?:contact|sollicit|d[ée]march|relanc|d[ée]rang)[ée]e?s?|recevoir\s+(?:aucun|de|des|vos|ces|d['’]autres)\b|rien\s+recevoir|(?:de\s+)?(?:contact|nouvelles?)\s+de\s+votre\s+part)(?![\p{L}\p{N}])/iu,
  // Droit d'opposition et d'effacement exercé.
  /\bje\s+(?:m['’]oppose|nous\s+opposons)\s+(?:à|a|au|aux)\s+(?:tou(?:t|te|s|tes)\s+|ce\s+|cette\s+|votre\s+|vos\s+)?(?:traitement|contact|d[ée]marchage|utilisation|usage|envois?|sollicitations?|donn[ée]es)\b|\bj['’]exerce\s+(?:mon|notre)\s+droit\s+d['’]opposition\b/iu,
  /\b(?:supprim(?:ez|er)|effa[çc](?:ez|er))\s+(?:toutes\s+)?(?:mes|nos)\s+donn[ée]es(?:\s+personnelles)?\b|\bdroit\s+(?:à|a)\s+l['’]effacement\b/iu,
  // Anglais.
  /\bplease\s+(?:remove|unsubscribe|delete)\s+(?:me|us|my)\b|\bdo\s+not\s+(?:contact|email|write\s+to)\s+(?:me|us)\b|\bdon['’]t\s+(?:contact|email)\s+(?:me|us)\b|\bstop\s+(?:contacting|emailing|sending|writing\s+to)\s+(?:me|us)\b|\bremove\s+(?:me|us)\s+from\b|\bopt[-\s]?out\b/iu,
  // Formules d'origine.
  /\bne\s+(?:m['’]|nous\s+)[ée]crivez\s+plus\b|\bne\s+(?:me|nous)\s+(?:sollicitez|relancez)\s+plus\b/iu,
  /\bcessez\s+(?:vos\s+(?:envois|messages|courriels|e-?mails|sollicitations|relances)|de\s+(?:me|nous)\s+(?:contacter|[ée]crire|solliciter|relancer))\b/iu,
  /\bje\s+ne\s+(?:souhaite|veux|d[ée]sire)\s+plus\s+(?:être\s+(?:contact|sollicit)[ée]e?s?|recevoir\s+(?:vos|de|ces)\s+(?:e-?mails?|courriels?|messages?|sollicitations?|demandes?))\b/iu,
  /\bje\s+m['’]oppose\s+au\s+traitement\s+de\s+mes\s+donn[ée]es\b/iu,
  /\b(?:merci\s+de\s+ne\s+plus\s+(?:me|nous)\s+contacter|merci\s+de\s+(?:supprimer|retirer)\s+(?:mon\s+adresse|moi|nous)(?:\s+de\s+vos\s+listes?)?|(?:supprimez|retirez)\s+mon\s+adresse(?:\s+de\s+vos\s+listes?)?|ne\s+(?:me|nous)\s+contact(?:e|ez|er)\s+plus|retirez[-\s]?(?:moi|nous)(?:\s+de\s+vos\s+listes?)?|supprimez[-\s]?(?:moi|nous)(?:\s+de\s+vos\s+listes?)?|je\s+m['’]oppose\s+à\s+(?:tout|ce|votre)\s+contact|please\s+(?:remove|unsubscribe)\s+me|do\s+not\s+contact\s+me\s+again)\b/iu,
].map(unicodeWordBoundaries);

/**
 * Mots qui, sans former une demande explicite, laissent penser que le professionnel veut être
 * laissé tranquille (spam, plainte, CNIL, données personnelles, « arrêtez »…). Ils n'enregistrent
 * aucune opposition mais envoient la réponse en relecture avec le motif `possible_opposition`.
 */
const LOOSE_OPT_OUT_PATTERNS: RegExp[] = [
  /\b(?:spam|pourriel|harc[èe]l\w*|importun\w*|intrusi\w*|ind[ée]sirable\w*|abusi\w*)\b/iu,
  /\b(?:plainte|cnil|rgpd|gdpr|donn[ée]es\s+personnelles|protection\s+des\s+donn[ée]es|base\s+l[ée]gale|licit[ée]\s+du\s+traitement)\b/iu,
  /\b(?:d[ée]sabonn\w*|d[ée]sinscri\w*|unsubscribe|opt[-\s]?out|opposition|m['’]oppose|nous\s+opposons)\b/iu,
  /\b(?:arr[êe]t(?:ez|er|e)|cess(?:ez|er)|stopp?(?:ez|er)?|interdi\w*|refus(?:e|ons)\s+(?:tout|toute))\b/iu,
  /\b(?:d[ée]marchage|prospection|publicit[ée]|sollicitations?\s+(?:commerciales?|non\s+sollicit[ée]es?))\b/iu,
  /\b(?:comment|pourquoi|o[ùu])\s+(?:avez|avons)[-\s]?(?:vous|nous)\s+(?:obtenu|eu|trouv[ée])\s+(?:mon|notre|mes|nos)\b/iu,
].map(unicodeWordBoundaries);

function replyBodyForOptOut(bodyText: string): string {
  return replyTextForExtraction(bodyText)
    .replace(/\u00a0/g, " ")
    .trim();
}

/**
 * Detect an explicit request to stop contact in the authenticated sender's
 * reply. Quoted history is removed before this helper is called so an old
 * message cannot unsubscribe a contact by being forwarded back to us.
 */
export function detectInformationAgentContactOptOut(bodyText: string): boolean {
  const text = replyBodyForOptOut(bodyText);
  if (!text) return false;
  return STRICT_OPT_OUT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Reply that does not ask in so many words to stop contact but uses the vocabulary of a complaint or
 * of an objection. No opposition is recorded; a human reads it first (`possible_opposition`).
 */
export function detectPossibleInformationAgentContactOptOut(bodyText: string): boolean {
  const text = replyBodyForOptOut(bodyText);
  if (!text || detectInformationAgentContactOptOut(bodyText)) return false;
  return LOOSE_OPT_OUT_PATTERNS.some((pattern) => pattern.test(text));
}

export type InformationAgentReplyIntent = "opposition" | "agreement" | "ambiguous";

// Short, unambiguous confirmations ("oui", "d'accord", "confirmé"…) with no negation.
const EXPLICIT_AGREEMENT = unicodeWordBoundaries(
  /\b(?:oui|d['’]accord|bien\s+volontiers|volontiers|avec\s+plaisir|confirm[ée]s?|je\s+confirme|c['’]est\s+exact|ci[-\s]?joint(?:e|es|s)?|veuillez\s+trouver|pi[èe]ces?\s+jointes?)\b/iu,
);
const NEGATION = unicodeWordBoundaries(
  /\b(?:non|pas|jamais|aucun(?:e)?|refus(?:e|ons)?|impossible|n['’](?:est|ai|avons|a)\b|ne\s+\w+\s+pas)\b/iu,
);

/**
 * Classifies a reply from an authenticated sender. Only two outcomes are trusted without a
 * human: an explicit request to stop contact, and an explicit agreement or answer (information
 * extracted, or a plain confirmation without negation). Anything else is "ambiguous" and goes to
 * human review instead of being closed automatically.
 */
export function classifyInformationAgentReplyIntent(
  bodyText: string,
  { hasEvidence }: { hasEvidence: boolean },
): InformationAgentReplyIntent {
  if (detectInformationAgentContactOptOut(bodyText)) return "opposition";
  const text = replyTextForExtraction(bodyText)
    .replace(/\u00a0/g, " ")
    .trim();
  if (!text) return hasEvidence ? "agreement" : "ambiguous";
  if (NEGATION.test(text)) return hasEvidence ? "agreement" : "ambiguous";
  if (hasEvidence || EXPLICIT_AGREEMENT.test(text)) return "agreement";
  return "ambiguous";
}

export function collectInboundTokens(
  addresses: readonly string[],
  inboundDomain: string,
): string[] {
  const expectedDomain = inboundDomain.trim().toLowerCase();
  const localPartPattern = new RegExp(`^enquete\\+(${UUID_SOURCE})$`, "i");
  const tokens = new Set<string>();
  for (const address of addresses) {
    const email = normalizeEmail(address);
    const separatorIndex = email.lastIndexOf("@");
    if (separatorIndex <= 0 || email.slice(separatorIndex + 1) !== expectedDomain) continue;
    const match = localPartPattern.exec(email.slice(0, separatorIndex));
    if (match?.[1]) tokens.add(match[1].toLowerCase());
  }
  return [...tokens];
}

/**
 * « Ce n'est pas moi » : le destinataire dit qu'il n'est pas la bonne personne (pas l'avocat poursuivant de ce
 * dossier, erreur de destinataire). Détection prudente par mots-clés :
 * - `strong` : formules sans ambiguïté. Pour un envoi du pilote, arrêt automatique de celui-ci ; l'identité ne
 *   repasse qu'en validation manuelle.
 * - `possible` : vocabulaire voisin (pas concerné, autre cabinet, confrère). Aucun arrêt : le doute envoie la
 *   réponse en relecture humaine (`possible_wrong_recipient`).
 * L'historique cité est retiré avant l'analyse : un ancien message transféré ne déclenche rien.
 */
export type WrongRecipientSignal = "strong" | "possible";

const STRONG_WRONG_RECIPIENT_PATTERNS: RegExp[] = [
  /\bce\s+n['’]est\s+pas\s+moi\b/iu,
  /\berreur\s+de\s+destinataire\b|\bmauvais\s+destinataire\b|\bmauvaise\s+adresse\b/iu,
  /\bje\s+ne\s+suis\s+pas\s+(?:l['’]|le\s+|la\s+|votre\s+)?(?:avocat(?:e)?\s+(?:poursuivant(?:e)?|de\s+(?:ce|cette)\s+(?:dossier|vente|affaire))|bon\s+interlocuteur|bonne\s+personne|bon\s+destinataire|destinataire\s+(?:de\s+ce|concern))/iu,
  /\bje\s+ne\s+suis\s+pas\s+concern[ée]e?\s+par\s+(?:ce|cette)\s+(?:dossier|vente|affaire)\b/iu,
  /\bvous\s+(?:vous\s+(?:[êe]tes\s+tromp[ée]e?s?|trompez)|avez\s+fait\s+erreur)\b[^.!?\n]{0,40}\b(?:destinataire|adresse|personne)\b/iu,
  /\bi\s+am\s+not\s+the\s+(?:right\s+person|lawyer\s+(?:for|of)\s+this)\b|\bwrong\s+(?:recipient|person|address)\b/iu,
].map(unicodeWordBoundaries);

const POSSIBLE_WRONG_RECIPIENT_PATTERNS: RegExp[] = [
  /\bpas\s+concern[ée]e?\b|\bne\s+(?:traite|traitons)\s+pas\s+ce\b|\bautre\s+cabinet\b|\bconfr[èe]re\b|\bn['’]est\s+pas\s+(?:mon|notre)\s+dossier\b|\bne\s+me\s+concerne\s+pas\b/iu,
].map(unicodeWordBoundaries);

export function detectWrongRecipientSignal(bodyText: string): WrongRecipientSignal | null {
  const text = replyBodyForOptOut(bodyText);
  if (!text) return null;
  if (STRONG_WRONG_RECIPIENT_PATTERNS.some((pattern) => pattern.test(text))) return "strong";
  if (POSSIBLE_WRONG_RECIPIENT_PATTERNS.some((pattern) => pattern.test(text))) return "possible";
  return null;
}
