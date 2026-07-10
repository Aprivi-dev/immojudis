import type { AuctionSale } from "@/lib/types";

type DepartmentDefinition = readonly [code: string, name: string];

type RegionDefinition = {
  name: string;
  departments: readonly string[];
  aliases?: readonly string[];
};

export type FrenchGeoSearchResolution =
  | { kind: "department"; departments: string[] }
  | { kind: "region"; departments: string[] }
  | { kind: "postal_code"; postalCode: string }
  | { kind: "text"; text: string }
  | { kind: "empty" };

const DEPARTMENTS: readonly DepartmentDefinition[] = [
  ["01", "Ain"],
  ["02", "Aisne"],
  ["03", "Allier"],
  ["04", "Alpes-de-Haute-Provence"],
  ["05", "Hautes-Alpes"],
  ["06", "Alpes-Maritimes"],
  ["07", "Ardèche"],
  ["08", "Ardennes"],
  ["09", "Ariège"],
  ["10", "Aube"],
  ["11", "Aude"],
  ["12", "Aveyron"],
  ["13", "Bouches-du-Rhône"],
  ["14", "Calvados"],
  ["15", "Cantal"],
  ["16", "Charente"],
  ["17", "Charente-Maritime"],
  ["18", "Cher"],
  ["19", "Corrèze"],
  ["2A", "Corse-du-Sud"],
  ["2B", "Haute-Corse"],
  ["21", "Côte-d'Or"],
  ["22", "Côtes-d'Armor"],
  ["23", "Creuse"],
  ["24", "Dordogne"],
  ["25", "Doubs"],
  ["26", "Drôme"],
  ["27", "Eure"],
  ["28", "Eure-et-Loir"],
  ["29", "Finistère"],
  ["30", "Gard"],
  ["31", "Haute-Garonne"],
  ["32", "Gers"],
  ["33", "Gironde"],
  ["34", "Hérault"],
  ["35", "Ille-et-Vilaine"],
  ["36", "Indre"],
  ["37", "Indre-et-Loire"],
  ["38", "Isère"],
  ["39", "Jura"],
  ["40", "Landes"],
  ["41", "Loir-et-Cher"],
  ["42", "Loire"],
  ["43", "Haute-Loire"],
  ["44", "Loire-Atlantique"],
  ["45", "Loiret"],
  ["46", "Lot"],
  ["47", "Lot-et-Garonne"],
  ["48", "Lozère"],
  ["49", "Maine-et-Loire"],
  ["50", "Manche"],
  ["51", "Marne"],
  ["52", "Haute-Marne"],
  ["53", "Mayenne"],
  ["54", "Meurthe-et-Moselle"],
  ["55", "Meuse"],
  ["56", "Morbihan"],
  ["57", "Moselle"],
  ["58", "Nièvre"],
  ["59", "Nord"],
  ["60", "Oise"],
  ["61", "Orne"],
  ["62", "Pas-de-Calais"],
  ["63", "Puy-de-Dôme"],
  ["64", "Pyrénées-Atlantiques"],
  ["65", "Hautes-Pyrénées"],
  ["66", "Pyrénées-Orientales"],
  ["67", "Bas-Rhin"],
  ["68", "Haut-Rhin"],
  ["69", "Rhône"],
  ["70", "Haute-Saône"],
  ["71", "Saône-et-Loire"],
  ["72", "Sarthe"],
  ["73", "Savoie"],
  ["74", "Haute-Savoie"],
  ["75", "Paris"],
  ["76", "Seine-Maritime"],
  ["77", "Seine-et-Marne"],
  ["78", "Yvelines"],
  ["79", "Deux-Sèvres"],
  ["80", "Somme"],
  ["81", "Tarn"],
  ["82", "Tarn-et-Garonne"],
  ["83", "Var"],
  ["84", "Vaucluse"],
  ["85", "Vendée"],
  ["86", "Vienne"],
  ["87", "Haute-Vienne"],
  ["88", "Vosges"],
  ["89", "Yonne"],
  ["90", "Territoire de Belfort"],
  ["91", "Essonne"],
  ["92", "Hauts-de-Seine"],
  ["93", "Seine-Saint-Denis"],
  ["94", "Val-de-Marne"],
  ["95", "Val-d'Oise"],
  ["971", "Guadeloupe"],
  ["972", "Martinique"],
  ["973", "Guyane"],
  ["974", "La Réunion"],
  ["976", "Mayotte"],
];

const REGIONS: readonly RegionDefinition[] = [
  {
    name: "Auvergne-Rhône-Alpes",
    departments: ["01", "03", "07", "15", "26", "38", "42", "43", "63", "69", "73", "74"],
    aliases: ["ARA"],
  },
  {
    name: "Bourgogne-Franche-Comté",
    departments: ["21", "25", "39", "58", "70", "71", "89", "90"],
    aliases: ["BFC"],
  },
  { name: "Bretagne", departments: ["22", "29", "35", "56"] },
  { name: "Centre-Val de Loire", departments: ["18", "28", "36", "37", "41", "45"] },
  { name: "Corse", departments: ["2A", "2B"] },
  {
    name: "Grand Est",
    departments: ["08", "10", "51", "52", "54", "55", "57", "67", "68", "88"],
  },
  { name: "Hauts-de-France", departments: ["02", "59", "60", "62", "80"] },
  {
    name: "Île-de-France",
    departments: ["75", "77", "78", "91", "92", "93", "94", "95"],
    aliases: ["IDF"],
  },
  { name: "Normandie", departments: ["14", "27", "50", "61", "76"] },
  {
    name: "Nouvelle-Aquitaine",
    departments: ["16", "17", "19", "23", "24", "33", "40", "47", "64", "79", "86", "87"],
  },
  {
    name: "Occitanie",
    departments: ["09", "11", "12", "30", "31", "32", "34", "46", "48", "65", "66", "81", "82"],
  },
  { name: "Pays de la Loire", departments: ["44", "49", "53", "72", "85"] },
  {
    name: "Provence-Alpes-Côte d'Azur",
    departments: ["04", "05", "06", "13", "83", "84"],
    aliases: ["PACA"],
  },
  { name: "Guadeloupe", departments: ["971"] },
  { name: "Martinique", departments: ["972"] },
  { name: "Guyane", departments: ["973"] },
  { name: "La Réunion", departments: ["974"], aliases: ["Réunion"] },
  { name: "Mayotte", departments: ["976"] },
];

const DEPARTMENT_BY_SEARCH_KEY = new Map<string, string>();
const DEPARTMENT_NAME_BY_CODE = new Map<string, string>();
const REGION_BY_SEARCH_KEY = new Map<string, readonly string[]>();

for (const [code, name] of DEPARTMENTS) {
  DEPARTMENT_BY_SEARCH_KEY.set(normalizeFrenchSearchText(code), code);
  DEPARTMENT_BY_SEARCH_KEY.set(normalizeFrenchSearchText(name), code);
  DEPARTMENT_NAME_BY_CODE.set(code.toUpperCase(), name);
}

for (const region of REGIONS) {
  for (const label of [region.name, ...(region.aliases ?? [])]) {
    REGION_BY_SEARCH_KEY.set(normalizeFrenchSearchText(label), region.departments);
  }
}

export function normalizeFrenchSearchText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function frenchSearchTerms(value: string | null | undefined): string[] {
  const normalized = normalizeFrenchSearchText(value);
  return normalized ? normalized.split(" ").filter(Boolean) : [];
}

export function departmentSearchValues(codes: readonly string[]): string[] {
  return Array.from(
    new Set(
      codes.flatMap((code) => {
        const normalizedCode = code.trim().toUpperCase();
        const name = DEPARTMENT_NAME_BY_CODE.get(normalizedCode);
        return name ? [normalizedCode, name] : [normalizedCode];
      }),
    ),
  );
}

export function resolveFrenchGeoSearch(
  value: string | null | undefined,
): FrenchGeoSearchResolution {
  const raw = value?.trim();
  if (!raw) return { kind: "empty" };

  const normalized = normalizeFrenchSearchText(raw);
  if (/^\d{5}$/.test(normalized)) {
    return { kind: "postal_code", postalCode: normalized };
  }

  const administrativeName = stripAdministrativePrefix(normalized);
  const regionDepartments = REGION_BY_SEARCH_KEY.get(administrativeName);
  if (regionDepartments) {
    return { kind: "region", departments: [...regionDepartments] };
  }

  const department = DEPARTMENT_BY_SEARCH_KEY.get(administrativeName);
  if (department) {
    return { kind: "department", departments: [department] };
  }

  return { kind: "text", text: raw };
}

export function matchesFrenchGeoSearch(
  sale: Pick<
    AuctionSale,
    | "title"
    | "description"
    | "source_description"
    | "llm_display_description"
    | "about_description"
    | "city"
    | "department"
    | "postal_code"
    | "address"
    | "tribunal"
    | "tribunal_code"
    | "tribunal_name"
    | "tribunal_city"
    | "property_type"
    | "source_name"
    | "primary_source"
  >,
  value: string | null | undefined,
): boolean {
  const resolution = resolveFrenchGeoSearch(value);
  if (resolution.kind === "empty") return true;
  if (resolution.kind === "department" || resolution.kind === "region") {
    return resolution.departments.includes(normalizeDepartmentCode(sale.department));
  }
  if (resolution.kind === "postal_code") {
    return normalizeFrenchSearchText(sale.postal_code) === resolution.postalCode;
  }

  if (resolution.kind === "text") {
    return matchesFrenchSearchText(sale, resolution.text);
  }

  return false;
}

export function matchesFrenchSearchText(
  sale: Parameters<typeof matchesFrenchGeoSearch>[0],
  value: string | null | undefined,
): boolean {
  const terms = frenchSearchTerms(value);
  if (!terms.length) return true;

  const departmentCode = normalizeDepartmentCode(sale.department);
  const haystack = normalizeFrenchSearchText(
    [
      sale.title,
      sale.description,
      sale.source_description,
      sale.llm_display_description,
      sale.about_description,
      sale.city,
      sale.department,
      DEPARTMENT_NAME_BY_CODE.get(departmentCode),
      sale.postal_code,
      sale.address,
      sale.tribunal,
      sale.tribunal_code,
      sale.tribunal_name,
      sale.tribunal_city,
      sale.property_type,
      sale.source_name,
      sale.primary_source,
    ]
      .filter(Boolean)
      .join(" "),
  );

  return terms.every((term) => haystack.includes(term));
}

function stripAdministrativePrefix(value: string): string {
  return value
    .replace(/^(?:region|departement|dept)\s+/, "")
    .replace(/^(?:du|de la|de l|des|de|d)\s+/, "")
    .trim();
}

function normalizeDepartmentCode(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  return DEPARTMENT_BY_SEARCH_KEY.get(normalizeFrenchSearchText(raw)) ?? raw.toUpperCase();
}
