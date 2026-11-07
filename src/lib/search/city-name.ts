/**
 * Petits mots qu'un nom de commune lie par un trait d'union et écrit en minuscules : « Aix-en-Provence »,
 * « Boulogne-sur-Mer », « Bourg-la-Reine », « Villeneuve-lès-Avignon », « Saint-Pierre-des-Corps ».
 */
const LINKED_PARTICLES = new Set([
  "au",
  "aux",
  "de",
  "des",
  "du",
  "en",
  "et",
  "la",
  "le",
  "les",
  "lès",
  "lez",
  "sous",
  "sur",
]);

/** « D'Olonne », « L'Isle » après un trait d'union : l'élision s'écrit en minuscule. */
const LINKED_ELISION = /^([DL])(['’])/;

/**
 * Nom de commune tel qu'il s'affiche dans le catalogue : les petits mots liés par un trait d'union
 * passent en minuscules (« Aix-En-Provence » devient « Aix-en-Provence », « Les Sables-D'Olonne »
 * devient « Les Sables-d'Olonne »), pour qu'une même ville ne s'écrive pas de deux façons d'une carte
 * à l'autre. Le premier mot n'est jamais touché (« Le Havre », « La Rochelle »), ni un nom écrit
 * tout en capitales (« AIX-EN-PROVENCE » resterait illisible à moitié corrigé).
 *
 * Affichage seulement : la donnée, l'adresse de la recherche et les filtres gardent la valeur reçue.
 */
export function displayCityName(city: string): string;
export function displayCityName(city: string | null | undefined): string | null | undefined;
export function displayCityName(city: string | null | undefined): string | null | undefined {
  if (!city || !city.includes("-") || city === city.toLocaleUpperCase("fr-FR")) return city;
  return city
    .split("-")
    .map((part, index) => {
      if (index === 0) return part;
      if (LINKED_PARTICLES.has(part.toLocaleLowerCase("fr-FR"))) {
        return part.toLocaleLowerCase("fr-FR");
      }
      return part.replace(LINKED_ELISION, (_, letter: string, apostrophe: string) => {
        return `${letter.toLocaleLowerCase("fr-FR")}${apostrophe}`;
      });
    })
    .join("-");
}

/** La vente avec le nom de sa commune mis en forme pour l'affichage (même objet s'il ne change pas). */
export function withDisplayCity<T extends { city?: string | null }>(sale: T): T {
  const city = displayCityName(sale.city);
  return city === sale.city ? sale : { ...sale, city };
}
