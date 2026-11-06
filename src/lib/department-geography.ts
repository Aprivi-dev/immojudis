/**
 * Géographie des départements pour les pages « Ventes aux enchères par département » : région de
 * chaque département (liste groupée de l'index, surtitre d'une page) et centre de chaque
 * département de métropole (carte en ronds proportionnels de l'index). Tables statiques : elles ne
 * changent qu'avec le découpage administratif.
 */

/**
 * Les 13 régions de métropole (code officiel géographique de l'INSEE, découpage en vigueur depuis
 * 2016) et l'outre-mer, dans l'ordre alphabétique, celui de la liste de l'index. Chaque département
 * figure dans une seule région (un test le vérifie pour les 101 départements).
 */
export const DEPARTMENT_REGIONS: ReadonlyArray<{
  /** Code de la région au COG de l'INSEE ; `null` pour le groupe « Outre-mer ». */
  inseeCode: string | null;
  name: string;
  departments: readonly string[];
}> = [
  {
    inseeCode: "84",
    name: "Auvergne-Rhône-Alpes",
    departments: ["01", "03", "07", "15", "26", "38", "42", "43", "63", "69", "73", "74"],
  },
  {
    inseeCode: "27",
    name: "Bourgogne-Franche-Comté",
    departments: ["21", "25", "39", "58", "70", "71", "89", "90"],
  },
  { inseeCode: "53", name: "Bretagne", departments: ["22", "29", "35", "56"] },
  {
    inseeCode: "24",
    name: "Centre-Val de Loire",
    departments: ["18", "28", "36", "37", "41", "45"],
  },
  { inseeCode: "94", name: "Corse", departments: ["2A", "2B"] },
  {
    inseeCode: "44",
    name: "Grand Est",
    departments: ["08", "10", "51", "52", "54", "55", "57", "67", "68", "88"],
  },
  { inseeCode: "32", name: "Hauts-de-France", departments: ["02", "59", "60", "62", "80"] },
  {
    inseeCode: "11",
    name: "Île-de-France",
    departments: ["75", "77", "78", "91", "92", "93", "94", "95"],
  },
  { inseeCode: "28", name: "Normandie", departments: ["14", "27", "50", "61", "76"] },
  {
    inseeCode: "75",
    name: "Nouvelle-Aquitaine",
    departments: ["16", "17", "19", "23", "24", "33", "40", "47", "64", "79", "86", "87"],
  },
  {
    inseeCode: "76",
    name: "Occitanie",
    departments: ["09", "11", "12", "30", "31", "32", "34", "46", "48", "65", "66", "81", "82"],
  },
  { inseeCode: "52", name: "Pays de la Loire", departments: ["44", "49", "53", "72", "85"] },
  {
    inseeCode: "93",
    name: "Provence-Alpes-Côte d'Azur",
    departments: ["04", "05", "06", "13", "83", "84"],
  },
  { inseeCode: null, name: "Outre-mer", departments: ["971", "972", "973", "974", "976"] },
];

const REGION_BY_DEPARTMENT = new Map(
  DEPARTMENT_REGIONS.flatMap((region) =>
    region.departments.map((code) => [code, region.name] as const),
  ),
);

/** Nom de la région d'un département (« Outre-mer » pour les cinq départements d'outre-mer). */
export function departmentRegionName(code: string): string | null {
  return REGION_BY_DEPARTMENT.get(code) ?? null;
}

/**
 * Centre (latitude, longitude en degrés WGS 84) de chaque département de métropole : centroïde,
 * pondéré par la surface, des tracés officiels des départements.
 *
 * Source : « Contours administratifs » d'Etalab, millésime 2026, fichier
 * `departements-1000m.geojson`
 * (https://etalab-datasets.geo.data.gouv.fr/contours-administratifs/2026/geojson/, fiche
 * https://www.data.gouv.fr/datasets/contours-administratifs), dérivé d'IGN Admin Express et publié
 * sous Licence Ouverte. C'est la source des contours que la recherche dessine déjà
 * (`src/lib/geographic-boundary.ts`).
 *
 * Calcul (relevé le 6 novembre 2026) : pour chaque département, centroïde de ses polygones (îles
 * comprises, trous retirés) dans un plan où la longitude est multipliée par le cosinus de la
 * latitude moyenne du département, arrondi au millième de degré (une centaine de mètres). Les
 * départements d'outre-mer ne sont pas sur la carte : ils sont dans la liste.
 */
export const DEPARTMENT_CENTROIDS: Readonly<Record<string, readonly [lat: number, lon: number]>> = {
  "01": [46.099, 5.348], // Ain
  "02": [49.56, 3.558], // Aisne
  "03": [46.394, 3.188], // Allier
  "04": [44.107, 6.245], // Alpes-de-Haute-Provence
  "05": [44.664, 6.263], // Hautes-Alpes
  "06": [43.939, 7.117], // Alpes-Maritimes
  "07": [44.753, 4.426], // Ardèche
  "08": [49.615, 4.641], // Ardennes
  "09": [42.922, 1.504], // Ariège
  "10": [48.305, 4.161], // Aube
  "11": [43.103, 2.414], // Aude
  "12": [44.281, 2.679], // Aveyron
  "13": [43.546, 5.086], // Bouches-du-Rhône
  "14": [49.099, -0.362], // Calvados
  "15": [45.051, 2.669], // Cantal
  "16": [45.718, 0.202], // Charente
  "17": [45.774, -0.678], // Charente-Maritime
  "18": [47.066, 2.491], // Cher
  "19": [45.358, 1.878], // Corrèze
  "21": [47.426, 4.772], // Côte-d'Or
  "22": [48.439, -2.866], // Côtes-d'Armor
  "23": [46.091, 2.018], // Creuse
  "24": [45.105, 0.74], // Dordogne
  "25": [47.166, 6.363], // Doubs
  "26": [44.687, 5.167], // Drôme
  "27": [49.114, 0.997], // Eure
  "28": [48.388, 1.37], // Eure-et-Loir
  "29": [48.26, -4.054], // Finistère
  "2A": [41.863, 8.989], // Corse-du-Sud
  "2B": [42.394, 9.206], // Haute-Corse
  "30": [43.993, 4.179], // Gard
  "31": [43.36, 1.175], // Haute-Garonne
  "32": [43.693, 0.453], // Gers
  "33": [44.839, -0.583], // Gironde
  "34": [43.579, 3.368], // Hérault
  "35": [48.155, -1.637], // Ille-et-Vilaine
  "36": [46.779, 1.576], // Indre
  "37": [47.258, 0.691], // Indre-et-Loire
  "38": [45.264, 5.574], // Isère
  "39": [46.73, 5.697], // Jura
  "40": [43.966, -0.784], // Landes
  "41": [47.617, 1.427], // Loir-et-Cher
  "42": [45.728, 4.165], // Loire
  "43": [45.128, 3.808], // Haute-Loire
  "44": [47.363, -1.679], // Loire-Atlantique
  "45": [47.912, 2.344], // Loiret
  "46": [44.624, 1.605], // Lot
  "47": [44.368, 0.461], // Lot-et-Garonne
  "48": [44.518, 3.5], // Lozère
  "49": [47.39, -0.559], // Maine-et-Loire
  "50": [49.081, -1.329], // Manche
  "51": [48.95, 4.239], // Marne
  "52": [48.111, 5.226], // Haute-Marne
  "53": [48.147, -0.657], // Mayenne
  "54": [48.788, 6.162], // Meurthe-et-Moselle
  "55": [48.991, 5.382], // Meuse
  "56": [47.848, -2.809], // Morbihan
  "57": [49.036, 6.662], // Moselle
  "58": [47.116, 3.505], // Nièvre
  "59": [50.448, 3.212], // Nord
  "60": [49.41, 2.423], // Oise
  "61": [48.623, 0.128], // Orne
  "62": [50.494, 2.287], // Pas-de-Calais
  "63": [45.726, 3.14], // Puy-de-Dôme
  "64": [43.256, -0.761], // Pyrénées-Atlantiques
  "65": [43.055, 0.164], // Hautes-Pyrénées
  "66": [42.6, 2.522], // Pyrénées-Orientales
  "67": [48.671, 7.552], // Bas-Rhin
  "68": [47.861, 7.274], // Haut-Rhin
  "69": [45.872, 4.641], // Rhône
  "70": [47.641, 6.087], // Haute-Saône
  "71": [46.645, 4.542], // Saône-et-Loire
  "72": [47.995, 0.223], // Sarthe
  "73": [45.478, 6.442], // Savoie
  "74": [46.035, 6.429], // Haute-Savoie
  "75": [48.856, 2.343], // Paris
  "76": [49.654, 1.029], // Seine-Maritime
  "77": [48.628, 2.934], // Seine-et-Marne
  "78": [48.815, 1.842], // Yvelines
  "79": [46.556, -0.319], // Deux-Sèvres
  "80": [49.957, 2.277], // Somme
  "81": [43.786, 2.167], // Tarn
  "82": [44.086, 1.283], // Tarn-et-Garonne
  "83": [43.443, 6.245], // Var
  "84": [44.007, 5.177], // Vaucluse
  "85": [46.676, -1.298], // Vendée
  "86": [46.565, 0.459], // Vienne
  "87": [45.893, 1.235], // Haute-Vienne
  "88": [48.196, 6.381], // Vosges
  "89": [47.84, 3.563], // Yonne
  "90": [47.633, 6.928], // Territoire de Belfort
  "91": [48.522, 2.243], // Essonne
  "92": [48.847, 2.246], // Hauts-de-Seine
  "93": [48.918, 2.479], // Seine-Saint-Denis
  "94": [48.777, 2.469], // Val-de-Marne
  "95": [49.082, 2.13], // Val-d'Oise
};

// ── Carte de l'index ──────────────────────────────────────────────────────

/** Repère de la carte : 1 060 × 1 000 unités, la métropole et la Corse entières. */
export const FRANCE_MAP_WIDTH = 1060;
export const FRANCE_MAP_HEIGHT = 1000;

/** Unités de carte par degré de latitude ; la longitude est réduite par le cosinus de 46,6°. */
const MAP_SCALE = 100;
const MAP_LON_FACTOR = Math.cos((46.6 * Math.PI) / 180);
const MAP_WEST = -5.3;
const MAP_NORTH = 51.3;

/** Paris et la petite couronne, trop serrés à l'échelle de la France, vont dans un médaillon. */
export const FRANCE_MAP_INSET_DEPARTMENTS: ReadonlySet<string> = new Set(["75", "92", "93", "94"]);

/** Le médaillon, dans l'angle sud-ouest (l'océan) : position, taille et grossissement. */
export const FRANCE_MAP_INSET = {
  x: 10,
  y: 640,
  width: 280,
  height: 320,
  center: [48.85, 2.36] as const,
  zoom: 8.4,
};

/** Position sur la carte (projection plate, longitude réduite à la latitude moyenne de la métropole). */
export function projectOnFranceMap(lat: number, lon: number): { x: number; y: number } {
  return {
    x: (lon - MAP_WEST) * MAP_LON_FACTOR * MAP_SCALE + 20,
    y: (MAP_NORTH - lat) * MAP_SCALE + 10,
  };
}

/** Position dans le médaillon de Paris et de la petite couronne. */
export function projectInFranceMapInset(lat: number, lon: number): { x: number; y: number } {
  const { x, y, width, height, center, zoom } = FRANCE_MAP_INSET;
  return {
    x: x + width / 2 + (lon - center[1]) * MAP_LON_FACTOR * MAP_SCALE * zoom,
    y: y + height / 2 + 24 - (lat - center[0]) * MAP_SCALE * zoom,
  };
}

/** Rayon du plus grand rond (le département qui compte le plus de ventes), en unités de carte. */
export const FRANCE_MAP_MAX_RADIUS = 44;
/** Rayon d'un département sans vente : un rond vide. */
export const FRANCE_MAP_EMPTY_RADIUS = 6;

/**
 * Rayon d'un rond : son aire est proportionnelle au nombre de ventes, le plus grand mesurant
 * `FRANCE_MAP_MAX_RADIUS`. `null` sans vente (rond vide de rayon fixe).
 */
export function franceMapRadius(count: number, maxCount: number): number | null {
  if (!(count > 0) || !(maxCount > 0)) return null;
  return FRANCE_MAP_MAX_RADIUS * Math.sqrt(count / maxCount);
}

/**
 * Valeurs de la légende : 1, une valeur « ronde » intermédiaire et la plus grande valeur ronde
 * (1, 2 ou 5 × 10ⁿ) qui ne dépasse pas le maximum. Sans doublon, croissantes.
 */
export function franceMapLegendValues(maxCount: number): number[] {
  if (!(maxCount >= 1)) return [];
  const roundBelow = (value: number) => {
    const power = 10 ** Math.floor(Math.log10(value));
    return [5, 2, 1].map((step) => step * power).find((candidate) => candidate <= value) ?? power;
  };
  const top = roundBelow(maxCount);
  const middle = top >= 10 ? roundBelow(top / 4) : null;
  return [...new Set([1, middle, top].filter((value): value is number => value != null))].sort(
    (a, b) => a - b,
  );
}
