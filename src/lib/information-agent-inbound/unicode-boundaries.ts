/**
 * `\b` de JavaScript ne connaît que l'ASCII, même avec le drapeau `u` : après une lettre accentuée
 * (« inoccupé », « contacté », « désinscription »), il n'y a jamais de frontière de mot. Une règle
 * qui se termine par `é\b` ne reconnaît alors le mot que s'il est suivi d'une lettre.
 * `unicodeWordBoundaries` réécrit chaque `\b` d'un motif en frontière Unicode (lettres, chiffres, `_`).
 */
const WORD = String.raw`[\p{L}\p{N}_]`;
const UNICODE_BOUNDARY = String.raw`(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;

export function unicodeWordBoundaries(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("u") ? pattern.flags : `${pattern.flags}u`;
  // Un `\b` précédé d'un nombre pair de barres obliques inverses est bien une frontière.
  const source = pattern.source.replace(
    /(?<!\\)((?:\\\\)*)\\b/g,
    (_match, slashes: string) => `${slashes}${UNICODE_BOUNDARY}`,
  );
  return new RegExp(source, flags);
}
