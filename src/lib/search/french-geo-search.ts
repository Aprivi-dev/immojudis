import { departmentFromPostalCode } from "@/lib/commune-names";
import { DEPARTMENT_REGIONS } from "@/lib/department-geography";
import { FRENCH_DEPARTMENTS } from "@/lib/departments";
import type { AuctionSale } from "@/lib/types";

export type FrenchGeoSearchResolution =
  | { kind: "department"; departments: string[] }
  | { kind: "region"; departments: string[] }
  | { kind: "postal_code"; postalCode: string }
  | { kind: "text"; text: string }
  | { kind: "empty" };

/** Noms que l'on tape aussi pour une région, en plus de son nom officiel. */
const REGION_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "Auvergne-Rhône-Alpes": ["ARA"],
  "Bourgogne-Franche-Comté": ["BFC"],
  "Île-de-France": ["IDF"],
  "Provence-Alpes-Côte d'Azur": ["PACA"],
  "La Réunion": ["Réunion"],
};

const DEPARTMENT_BY_SEARCH_KEY = new Map<string, string>();
const DEPARTMENT_NAME_BY_CODE = new Map<string, string>();
const REGION_BY_SEARCH_KEY = new Map<string, readonly string[]>();

for (const { code, name } of FRENCH_DEPARTMENTS) {
  DEPARTMENT_BY_SEARCH_KEY.set(normalizeFrenchSearchText(code), code);
  DEPARTMENT_BY_SEARCH_KEY.set(normalizeFrenchSearchText(name), code);
  DEPARTMENT_NAME_BY_CODE.set(code.toUpperCase(), name);
}

// Les 13 régions de métropole des pages par département. Leur groupe « Outre-mer » n'est pas une
// région : chacun de ses départements en est une, sous son propre nom.
const REGIONS = DEPARTMENT_REGIONS.flatMap<{ name: string; departments: readonly string[] }>(
  (region) =>
    region.inseeCode
      ? [region]
      : FRENCH_DEPARTMENTS.filter(({ code }) => region.departments.includes(code)).map(
          ({ code, name }) => ({ name, departments: [code] }),
        ),
);

for (const region of REGIONS) {
  for (const label of [region.name, ...(REGION_ALIASES[region.name] ?? [])]) {
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
 * Le département que désigne un texte saisi, quand il n'en désigne qu'un : son nom ou son code
 * (« Gironde », « 33 », « 2A », « 974 ») ou un code postal (« 33000 », `departmentFromPostalCode`).
 * `null` pour une région, plusieurs départements (« 66, 65, 05 »), un code qui n'est pas celui d'un
 * département (« 20 ») ou tout autre texte.
 */
export function departmentFromSearchText(text: string | null | undefined): string | null {
  const scope = resolveFrenchGeoSearch(text);
  if (scope.kind === "postal_code") return departmentFromPostalCode(scope.postalCode);
  return scope.kind === "department" && scope.departments.length === 1
    ? (scope.departments[0] ?? null)
    : null;
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
