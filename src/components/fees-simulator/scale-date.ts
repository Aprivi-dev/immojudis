import { formatDate } from "@/lib/format/dates";

/** « 09/10/2026 » devient « 09 octobre 2026 ». Renvoie le texte d'origine s'il n'a pas ce format. */
export function formatScaleDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  return match ? formatDate(`${match[3]}-${match[2]}-${match[1]}`, value) : value;
}
