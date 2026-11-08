import { FRENCH_DEPARTMENTS } from "@/lib/departments";
import type { AuctionSale } from "@/lib/types";

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

for (const { code, name } of FRENCH_DEPARTMENTS) {
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

  const departmentList = departmentsFromList(raw, normalized);
  if (departmentList) {
    return { kind: "department", departments: departmentList };
  }

  return { kind: "text", text: raw };
}

/**
 * Plusieurs départements tapés à la suite (« 66, 65, 05 », « Gers et Landes », « 66 65 05 ») : la
 * liste de leurs codes, ou `null` dès qu'un élément n'est pas un département. Les éléments se
 * séparent par une virgule, un point-virgule, une barre oblique, « + », « & » ou « et » ; des codes
 * seuls peuvent aussi être séparés par des espaces.
 */
function departmentsFromList(raw: string, normalized: string): string[] | null {
  const departmentKey = (value: string) =>
    stripAdministrativePrefix(normalizeFrenchSearchText(value));
  // « Seine et Marne » est un département : « et » ne sépare que ce qui n'en est pas un. Le texte
  // normalisé n'a que des espaces simples : « et » s'y découpe sans expression rationnelle (un
  // motif comme /\s+et\s+/ sur le texte tapé coûterait un temps quadratique sur une longue suite
  // d'espaces).
  const parts = raw
    .split(/[,;/+&]/)
    .map(departmentKey)
    .flatMap((key) =>
      DEPARTMENT_BY_SEARCH_KEY.has(key) ? [key] : key.split(" et ").map(stripAdministrativePrefix),
    )
    .filter(Boolean);
  const words = normalized.split(" ");
  const tokens =
    parts.length > 1 ? parts : words.every((word) => /^(\d{2,3}|2[ab])$/.test(word)) ? words : [];
  if (tokens.length < 2) return null;
  const codes: string[] = [];
  for (const token of tokens) {
    const code = DEPARTMENT_BY_SEARCH_KEY.get(token);
    if (!code) return null;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
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
