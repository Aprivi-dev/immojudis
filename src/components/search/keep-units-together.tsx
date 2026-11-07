import type { ReactNode } from "react";

/**
 * Un nombre et son unité : « 114 m² », « 2 500 €/m² », « 100 000 € ». `\s` couvre aussi les
 * espaces fines insécables que `Intl.NumberFormat` met entre les milliers.
 */
const NUMBER_WITH_UNIT = /(\d[\d\s]*\s(?:m²|€\/m²|€))/;

/**
 * Garde chaque nombre sur la même ligne que son unité : les titres de cartes (« Appartement de
 * 114 m² à Aix-en-Provence ») se coupaient entre « 114 » et « m² ». Le texte n'est pas modifié (même
 * nom accessible, même copier-coller) : seul le passage à la ligne est interdit, par un `span`.
 */
export function keepUnitsTogether(text: string): ReactNode {
  const parts = text.split(NUMBER_WITH_UNIT);
  if (parts.length === 1) return text;
  // Les morceaux de texte restent des chaînes : seuls les éléments d'un tableau demandent une clé.
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <span key={index} className="whitespace-nowrap">
        {part}
      </span>
    ) : (
      part
    ),
  );
}
