import { createHash } from "node:crypto";

export const CNB_DATASET_API_URL =
  "https://www.data.gouv.fr/api/1/datasets/annuaire-des-avocats-de-france/";
export const CNB_DATASET_PAGE_URL =
  "https://www.data.gouv.fr/datasets/annuaire-des-avocats-de-france";
export const OPEN_LICENSE_URL = "https://www.etalab.gouv.fr/licence-ouverte-open-licence";

const MAX_CSV_BYTES = 20 * 1024 * 1024;
const REQUIRED_HEADERS = [
  "NomBarreau",
  "avNom",
  "avPrenom",
  "cbRaisonSociale",
  "cbSiretSiren",
  "cbAdresse1",
  "cbAdresse2",
  "cbCp",
  "cbVille",
  "spLibelle1",
  "spLibelle2",
  "spLibelle3",
  "acDateSerment",
  "avLang",
] as const;

export type CnbDatasetResource = {
  id: string;
  title: string;
  url: string;
  publishedAt: string;
};

export type CnbLawyerImportRow = {
  source_key: string;
  bar_association: string;
  bar_key: string;
  last_name: string;
  first_name: string | null;
  display_name: string;
  firm_name: string | null;
  firm_siret_siren: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  postal_code: string | null;
  city: string | null;
  specializations: string[];
  oath_date: string | null;
  languages: string[];
  source_resource_id: string;
  source_updated_at: string;
  imported_at: string;
};

type DataGouvResource = {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  format?: unknown;
  type?: unknown;
  last_modified?: unknown;
};

export async function fetchLatestCnbDatasetResource(): Promise<CnbDatasetResource> {
  const response = await fetch(CNB_DATASET_API_URL, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Métadonnées CNB indisponibles (${response.status}).`);
  }

  const payload = (await response.json()) as { resources?: unknown };
  if (!Array.isArray(payload.resources)) {
    throw new Error("Le catalogue CNB ne contient aucune ressource exploitable.");
  }
  return selectLatestCnbDatasetResource(payload.resources as DataGouvResource[]);
}

export function selectLatestCnbDatasetResource(resources: DataGouvResource[]): CnbDatasetResource {
  const candidates = resources
    .map(toDatasetResource)
    .filter((resource): resource is CnbDatasetResource => resource != null)
    .sort((left, right) => resourceTimestamp(right) - resourceTimestamp(left));

  const latest = candidates[0];
  if (!latest) throw new Error("Aucun export CSV officiel du CNB n'a été trouvé.");
  return latest;
}

export async function fetchCnbCsv(resource: CnbDatasetResource): Promise<Uint8Array> {
  const resourceUrl = new URL(resource.url);
  if (resourceUrl.protocol !== "https:" || resourceUrl.hostname !== "static.data.gouv.fr") {
    throw new Error("L'URL de l'export CNB n'est pas une URL data.gouv.fr autorisée.");
  }

  const response = await fetch(resourceUrl, {
    cache: "no-store",
    headers: { accept: "text/csv,text/plain;q=0.9" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Export CNB indisponible (${response.status}).`);

  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_CSV_BYTES) {
    throw new Error("L'export CNB dépasse la taille maximale autorisée.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_CSV_BYTES) {
    throw new Error("L'export CNB dépasse la taille maximale autorisée.");
  }
  return bytes;
}

export function decodeCnbCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes).replace(/^\uFEFF/, "");
  }
}

export function parseCnbRealEstateLawyers(
  csv: string,
  resource: CnbDatasetResource,
  importedAt = new Date(),
): CnbLawyerImportRow[] {
  const iterator = parseSemicolonRows(csv)[Symbol.iterator]();
  let headers: string[] | null = null;
  for (let rowIndex = 0; rowIndex < 5; rowIndex += 1) {
    const candidate = iterator.next();
    if (candidate.done) break;
    const candidateHeaders = candidate.value.map((header) => header.replace(/^\uFEFF/, "").trim());
    if (candidateHeaders.includes("NomBarreau") && candidateHeaders.includes("avNom")) {
      headers = candidateHeaders;
      break;
    }
  }
  if (!headers) throw new Error("L'export CNB ne contient pas de ligne d'en-tête reconnue.");

  const headerIndexes = new Map(headers.map((header, index) => [header, index]));
  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headerIndexes.has(header));
  if (missingHeaders.length) {
    throw new Error(`Colonnes CNB absentes : ${missingHeaders.join(", ")}.`);
  }

  const importedAtIso = importedAt.toISOString();
  const lawyers = new Map<string, CnbLawyerImportRow>();
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    const row = next.value;
    const value = (header: (typeof REQUIRED_HEADERS)[number]) =>
      clean(row[headerIndexes.get(header) ?? -1]);
    const specializations = unique(
      [value("spLibelle1"), value("spLibelle2"), value("spLibelle3")].filter(
        (item): item is string => item != null,
      ),
    );
    if (!specializations.some(isRealEstateSpecialization)) continue;

    const barAssociation = value("NomBarreau");
    const lastName = value("avNom");
    if (!barAssociation || !lastName) continue;

    const firstName = value("avPrenom");
    const firmName = value("cbRaisonSociale");
    const firmSiretSiren = value("cbSiretSiren");
    const addressLine1 = value("cbAdresse1");
    const addressLine2 = value("cbAdresse2");
    const postalCode = value("cbCp");
    const city = value("cbVille");
    const barKey = normalizeBarKey(barAssociation);
    if (!barKey) continue;

    const identity = [
      barKey,
      normalizeKey(lastName),
      normalizeKey(firstName),
      normalizeKey(firmSiretSiren),
      normalizeKey(firmName),
      normalizeKey(addressLine1),
      normalizeKey(postalCode),
    ].join("|");
    const sourceKey = createHash("sha256").update(identity).digest("hex");
    const displayName = [firstName, lastName].filter(Boolean).join(" ");

    lawyers.set(sourceKey, {
      source_key: sourceKey,
      bar_association: barAssociation,
      bar_key: barKey,
      last_name: lastName,
      first_name: firstName,
      display_name: displayName,
      firm_name: firmName,
      firm_siret_siren: firmSiretSiren,
      address_line_1: addressLine1,
      address_line_2: addressLine2,
      postal_code: postalCode,
      city,
      specializations,
      oath_date: parseOathDate(value("acDateSerment")),
      languages: parseLanguages(value("avLang")),
      source_resource_id: resource.id,
      source_updated_at: resource.publishedAt,
      imported_at: importedAtIso,
    });
  }

  const result = Array.from(lawyers.values());
  if (!result.length || result.length > 5_000) {
    throw new Error(`Nombre de spécialistes CNB incohérent : ${result.length}.`);
  }
  return result;
}

export function normalizeBarKey(value: string | null | undefined): string | null {
  const cleaned = clean(value)
    ?.replace(/^\s*(?:ordre\s+des\s+avocats\s+du\s+)?barreau\s+(?:de\s+|du\s+|d[’']\s*)?/i, "")
    .replace(/\s+/g, " ");
  const key = normalizeKey(cleaned);
  return key || null;
}

function toDatasetResource(resource: DataGouvResource): CnbDatasetResource | null {
  const id = stringValue(resource.id);
  const title = stringValue(resource.title);
  const url = stringValue(resource.url);
  const publishedAt = stringValue(resource.last_modified);
  const format = stringValue(resource.format)?.toLowerCase();
  if (!id || !title || !url || !publishedAt || format !== "csv") return null;
  if (!/^annuaire-avocats-\d{8}\.csv$/i.test(title)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "static.data.gouv.fr") return null;
    if (!Number.isFinite(Date.parse(publishedAt))) return null;
  } catch {
    return null;
  }
  return { id, title, url, publishedAt };
}

function resourceTimestamp(resource: CnbDatasetResource) {
  const titleDate = resource.title.match(/(\d{4})(\d{2})(\d{2})/);
  if (titleDate) {
    return Date.UTC(Number(titleDate[1]), Number(titleDate[2]) - 1, Number(titleDate[3]));
  }
  return Date.parse(resource.publishedAt);
}

function* parseSemicolonRows(csv: string): Generator<string[]> {
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ";") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value.length > 0)) yield row;
      row = [];
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("L'export CNB contient une valeur CSV non terminée.");
  if (field.length || row.length) {
    row.push(field);
    if (row.some((value) => value.length > 0)) yield row;
  }
}

function parseOathDate(value: string | null): string | null {
  const match = value?.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

function parseLanguages(value: string | null): string[] {
  if (!value || value === "0") return [];
  return unique(
    value
      .split(",")
      .map(clean)
      .filter((language): language is string => language != null && language !== "0"),
  );
}

function isRealEstateSpecialization(value: string) {
  return normalizeKey(value) === "droit immobilier";
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function normalizeKey(value: string | null | undefined) {
  return (
    clean(value)
      ?.normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("fr")
      .replace(/[^a-z0-9]+/g, " ")
      .trim() ?? ""
  );
}

function clean(value: string | null | undefined) {
  const cleaned = value?.trim();
  return cleaned || null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
