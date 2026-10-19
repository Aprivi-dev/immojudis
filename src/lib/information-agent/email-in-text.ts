/**
 * Finds e-mail addresses inside free text (listing blocks, scraped contact lines).
 *
 * Scraped text often glues the next word to the address ("maitre.dupont@cabinet.frTél : 01 02…").
 * A case-insensitive `[A-Z]{2,}` top-level domain then swallows the first letters of that word
 * ("…frT"). The pattern is therefore case-aware:
 *
 * - a lowercase (or capitalised) TLD stops at the first character that cannot continue it, so an
 *   uppercase letter, a digit, a dot or a slash right after it ends the address;
 * - an all-caps TLD ("CABINET.FR") never absorbs a capital that starts a capitalised word
 *   ("FRTél" gives "FR");
 * - a TLD is at most 24 letters (".immobilier", ".paris" and ".notaires" all fit); a longer run of
 *   lowercase letters is not an address.
 *
 * What cannot be told apart stays as is: a lowercase word glued to a lowercase TLD
 * ("cabinet.frtel") reads as one TLD.
 */
const EMAIL_IN_TEXT_SOURCE = String.raw`[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+(?:[A-Z]{2,24}(?!\p{Ll})|[A-Za-z][a-z]{1,23}(?![a-z]))`;

/** A fresh global regex on each call, so callers never share `lastIndex` state. */
export function emailInTextPattern(): RegExp {
  return new RegExp(EMAIL_IN_TEXT_SOURCE, "gu");
}

/** Raw address matches, in order of appearance (not normalised, not deduplicated). */
export function findEmailsInText(value: string): string[] {
  return value.match(emailInTextPattern()) ?? [];
}

/** The text with every address replaced. */
export function replaceEmailsInText(value: string, replacement: string): string {
  return value.replace(emailInTextPattern(), replacement);
}
