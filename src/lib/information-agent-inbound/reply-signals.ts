import "server-only";
import { unicodeWordBoundaries } from "@/lib/information-agent-inbound/unicode-boundaries";

/**
 * Signaux lus dans une réponse avant son traitement : réponse automatique (absence, accusé de
 * réception) et lot de la vente. Aucun n'écrit en base ; l'appelant décide du traitement.
 */

/** En-têtes tels que le fournisseur les rend : objet, tableau de paires, ou absents. */
function normalizeHeaders(value: unknown): Map<string, string> {
  const headers = new Map<string, string>();
  const add = (name: unknown, headerValue: unknown) => {
    if (typeof name !== "string") return;
    const text = Array.isArray(headerValue)
      ? headerValue.filter((item) => typeof item === "string").join(", ")
      : typeof headerValue === "string"
        ? headerValue
        : "";
    headers.set(name.trim().toLowerCase(), text.trim());
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object") {
        const pair = item as { name?: unknown; value?: unknown };
        add(pair.name, pair.value);
      }
    }
  } else if (value && typeof value === "object") {
    for (const [name, headerValue] of Object.entries(value)) add(name, headerValue);
  }
  return headers;
}

/** Objets de réponse automatique : « Absence du bureau », « Out of office », « Réponse automatique »… */
const AUTO_REPLY_SUBJECT = unicodeWordBoundaries(
  /^\s*(?:(?:re|r[ée]|tr|fw|fwd)\s*:\s*)*(?:\[?\s*(?:r[ée]ponse\s+)?(?:automatique|auto(?:matic)?[-\s]?repl(?:y|ies))\s*\]?|absence(?:\s+(?:du\s+bureau|temporaire|de\s+\p{L}+|jusqu['’]au|le|du|cong[ée]s?))?|absent(?:e)?\b|out\s+of\s+(?:the\s+)?office|automatic\s+reply|auto[-\s]?reply|abwesenheit|cong[ée]s?\s+annuels?|fermeture\s+(?:du\s+cabinet|de\s+l['’][ée]tude))/iu,
);

/**
 * Réponse automatique d'un serveur de messagerie ou d'un répondeur : en-têtes `Auto-Submitted`
 * (RFC 3834, toute valeur sauf `no`), `X-Autoreply`, `X-Autorespond`, `Precedence: auto_reply`,
 * `X-Auto-Response-Suppress` annonçant une absence (`OOF`, `AutoReply`), ou objet « Absence… ».
 * Une telle réponse n'est pas celle du professionnel : on ne la lit pas (pas de modèle payant) et
 * elle ne ferme pas le dossier.
 */
export function isAutomaticReply({
  headers,
  subject,
}: {
  headers: unknown;
  subject: string | null | undefined;
}): boolean {
  const map = normalizeHeaders(headers);
  const autoSubmitted = map.get("auto-submitted");
  if (autoSubmitted !== undefined && autoSubmitted.toLowerCase() !== "no") return true;
  if (map.has("x-autoreply") || map.has("x-autorespond") || map.has("x-auto-reply")) return true;
  if (/auto[_-]?reply|auto[_-]?response/i.test(map.get("precedence") ?? "")) return true;
  if (/\b(?:oof|autoreply)\b/i.test(map.get("x-auto-response-suppress") ?? "")) return true;
  return AUTO_REPLY_SUBJECT.test(subject ?? "");
}

/**
 * La réponse désigne-t-elle un lot ? « lot 2 », « lots 1 et 3 », « lot n° 4 », « lot A », « lot
 * unique », « le premier lot », « tous les lots ». Sans cela, pour une vente à plusieurs lots, une
 * surface ou une occupation ne peut pas être rattachée à un lot.
 */
const LOT_MENTION = unicodeWordBoundaries(
  /\b(?:lots?\s*(?:n(?:°|º|o|um(?:[ée]ro)?s?)?\s*\.?\s*)?(?:\d+|[a-z]\b|unique|un|deux|trois|quatre|cinq)|(?:premier|second|seconde|deuxi[èe]me|troisi[èe]me|dernier|1er|2nd|2e|3e)\s+lot|(?:tous|toutes|chaque|ensemble)\s+(?:les\s+)?lots?|ensemble\s+des\s+lots|l['’]ensemble\s+des\s+lots|lot\s*:\s*\S+)/iu,
);

export function replyMentionsLot(text: string): boolean {
  return LOT_MENTION.test(text);
}
