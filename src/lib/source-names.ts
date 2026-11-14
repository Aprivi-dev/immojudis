/**
 * Noms lisibles des sources de ventes, par nom de source (`source_name` des ventes et de la supervision
 * des sources). Seule table : les liens des fiches publiques (`sale-source-links`) et l'administration
 * (libellés des alertes, accueil) la lisent. Module sans dépendance : il entre dans les pages publiques
 * comme dans l'administration sans rien y ajouter d'autre.
 */
const SOURCE_NAMES: Readonly<Record<string, string>> = {
  agrasc: "AGRASC",
  avoventes: "Avoventes",
  cessions_etat: "Cessions de l'Etat",
  encheres_immobilieres: "Enchères Immobilières",
  encheres_publiques: "Enchères Publiques",
  info_encheres: "Info-Enchères",
  licitor: "Licitor",
  notaires: "Immobilier.notaires",
  petites_affiches: "Petites Affiches",
  vench: "Vench",
};

/** Nom lisible d'une source connue, `null` sinon (jamais une clé héritée comme `constructor`). */
export function sourceDisplayName(sourceName: string): string | null {
  return Object.hasOwn(SOURCE_NAMES, sourceName) ? SOURCE_NAMES[sourceName] : null;
}
