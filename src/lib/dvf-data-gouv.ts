import type { MarketEngineCandidate, MarketPropertySegment } from "@/lib/market-estimation-engine";

const DATA_GOUV_DVF_BASE = "https://files.data.gouv.fr/geo-dvf/latest/csv";
const CACHE_TTL_MS = 12 * 60 * 60 * 1_000;
const HISTORY_YEARS = 5;

type OfficialDvfRow = Record<string, string>;

export type DataGouvCommuneLocation = {
  code: string;
  departmentCode: string;
};

export type DataGouvDvfCollection = {
  candidates: MarketEngineCandidate[];
  complete: boolean;
  missingYears: number[];
};

export type DataGouvParkingSale = {
  id: string;
  date: string;
  totalPrice: number;
  unitPrice: number;
  unitCount: number;
  latitude: number;
  longitude: number;
};

export type DataGouvParkingCollection = {
  sales: DataGouvParkingSale[];
  complete: boolean;
  missingYears: number[];
};

const collectionCache = new Map<
  string,
  { expiresAt: number; value: DataGouvDvfCollection | DataGouvParkingCollection | null }
>();

export async function fetchDataGouvDvfCommune(input: {
  location: DataGouvCommuneLocation;
  segment: Exclude<MarketPropertySegment, "unsupported">;
  now?: Date;
}): Promise<DataGouvDvfCollection | null> {
  const years = publishedYears(input.now ?? new Date());
  const cacheKey = `${input.location.departmentCode}:${input.location.code}:${input.segment}:${years.join(",")}`;
  const cached = collectionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value as DataGouvDvfCollection | null;
  }

  const batches = await Promise.all(
    years.map((year) => fetchOfficialCommuneYear(input.location, year)),
  );
  const successfulBatches = batches.filter((batch) => batch.ok);
  if (!successfulBatches.length) {
    collectionCache.set(cacheKey, { expiresAt: Date.now() + 60_000, value: null });
    return null;
  }

  const rows = successfulBatches.flatMap((batch) => batch.rows);
  const value: DataGouvDvfCollection = {
    candidates: officialRowsToCandidates(rows, input.segment),
    complete: batches.every((batch) => batch.ok),
    missingYears: years.filter((_, index) => !batches[index].ok),
  };
  collectionCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

export async function fetchDataGouvParkingCommune(input: {
  location: DataGouvCommuneLocation;
  now?: Date;
}): Promise<DataGouvParkingCollection | null> {
  const years = publishedYears(input.now ?? new Date());
  const cacheKey = `${input.location.departmentCode}:${input.location.code}:parking:${years.join(",")}`;
  const cached = collectionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value as DataGouvParkingCollection | null;
  }

  const batches = await Promise.all(
    years.map((year) => fetchOfficialCommuneYear(input.location, year)),
  );
  const successfulBatches = batches.filter((batch) => batch.ok);
  if (!successfulBatches.length) {
    collectionCache.set(cacheKey, { expiresAt: Date.now() + 60_000, value: null });
    return null;
  }

  const value: DataGouvParkingCollection = {
    sales: officialRowsToParkingSales(successfulBatches.flatMap((batch) => batch.rows)),
    complete: batches.every((batch) => batch.ok),
    missingYears: years.filter((_, index) => !batches[index].ok),
  };
  collectionCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

export function officialRowsToCandidates(
  rows: OfficialDvfRow[],
  segment: Exclude<MarketPropertySegment, "unsupported">,
): MarketEngineCandidate[] {
  const byMutation = new Map<string, OfficialDvfRow[]>();
  for (const row of rows) {
    if (row.nature_mutation !== "Vente") continue;
    const id = clean(row.id_mutation);
    if (!id) continue;
    const current = byMutation.get(id) ?? [];
    current.push(row);
    byMutation.set(id, current);
  }

  const candidates: MarketEngineCandidate[] = [];
  for (const [mutationId, mutationRows] of byMutation) {
    const candidate = mutationToCandidate(mutationId, mutationRows, segment);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export function officialRowsToParkingSales(rows: OfficialDvfRow[]): DataGouvParkingSale[] {
  const byMutation = new Map<string, OfficialDvfRow[]>();
  for (const row of rows) {
    if (row.nature_mutation !== "Vente") continue;
    const id = clean(row.id_mutation);
    if (!id) continue;
    const current = byMutation.get(id) ?? [];
    current.push(row);
    byMutation.set(id, current);
  }

  const sales: DataGouvParkingSale[] = [];
  for (const [mutationId, mutationRows] of byMutation) {
    const typedRows = mutationRows.filter((row) =>
      ["1", "2", "3", "4"].includes(row.code_type_local),
    );
    const dependencies = typedRows.filter((row) => row.code_type_local === "3");
    if (!dependencies.length || typedRows.some((row) => row.code_type_local !== "3")) continue;

    const totalPrice = firstPositive(mutationRows, "valeur_fonciere");
    const date = mutationRows.map((row) => clean(row.date_mutation)).find(Boolean) ?? null;
    const coordinates = averageCoordinates(dependencies);
    if (!totalPrice || !date || !coordinates) continue;

    const units = new Set(
      dependencies.map((row) =>
        [
          clean(row.id_parcelle) ?? "",
          clean(row.lot1_numero) ?? "",
          clean(row.lot2_numero) ?? "",
          clean(row.lot3_numero) ?? "",
          clean(row.lot4_numero) ?? "",
          clean(row.lot5_numero) ?? "",
        ].join("|"),
      ),
    );
    const unitCount = Math.max(1, units.size);
    const unitPrice = totalPrice / unitCount;
    if (unitPrice < 1_000 || unitPrice > 200_000) continue;

    sales.push({
      id: `data-gouv:${mutationId}`,
      date,
      totalPrice,
      unitPrice,
      unitCount,
      latitude: coordinates.lat,
      longitude: coordinates.lng,
    });
  }
  return sales;
}

export function parseCsvRecords(csv: string): OfficialDvfRow[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field.replace(/\r$/, ""));
      if (record.some((value) => value !== "")) records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || record.length) {
    record.push(field.replace(/\r$/, ""));
    records.push(record);
  }
  if (records.length < 2) return [];
  const headers = records[0].map((header) => header.replace(/^\uFEFF/, "").trim());
  return records
    .slice(1)
    .map((values) =>
      Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
    );
}

function mutationToCandidate(
  mutationId: string,
  rows: OfficialDvfRow[],
  segment: Exclude<MarketPropertySegment, "unsupported">,
): MarketEngineCandidate | null {
  const totalPrice = firstPositive(rows, "valeur_fonciere");
  const date = rows.map((row) => clean(row.date_mutation)).find(Boolean) ?? null;
  if (!totalPrice || !date) return null;

  const builtRows = uniqueBuiltRows(rows);
  if (segment === "land") {
    if (builtRows.length > 0) return null;
    const landByParcel = new Map<string, number>();
    for (const row of rows) {
      const surface = positive(row.surface_terrain);
      const parcel = clean(row.id_parcelle);
      if (!surface || !parcel) continue;
      landByParcel.set(parcel, Math.max(surface, landByParcel.get(parcel) ?? 0));
    }
    const landSurface = [...landByParcel.values()].reduce((sum, value) => sum + value, 0);
    const coordinates = averageCoordinates(rows);
    if (!landSurface || !coordinates) return null;
    return {
      id: `data-gouv:${mutationId}`,
      parcelId: [...landByParcel.keys()].sort().join("+") || mutationId,
      date,
      totalPrice,
      builtSurfaceM2: null,
      landSurfaceM2: landSurface,
      pricePerM2: totalPrice / landSurface,
      propertyType: "Terrain",
      segment,
      distanceM: 0,
      latitude: coordinates.lat,
      longitude: coordinates.lng,
    };
  }

  const expectedCode =
    segment === "apartment"
      ? "2"
      : segment === "house"
        ? "1"
        : segment === "commercial"
          ? "4"
          : null;
  let selectedRows: OfficialDvfRow[];
  if (segment === "building") {
    selectedRows = builtRows.filter(
      (row) => row.code_type_local === "1" || row.code_type_local === "2",
    );
    if (selectedRows.length < 2 || builtRows.some((row) => row.code_type_local === "4"))
      return null;
  } else {
    selectedRows = builtRows.filter((row) => row.code_type_local === expectedCode);
    if (selectedRows.length !== 1 || builtRows.length !== 1) return null;
  }

  const builtSurface = selectedRows.reduce(
    (sum, row) => sum + (positive(row.surface_reelle_bati) ?? 0),
    0,
  );
  const landSurface = maximumPositive(rows, "surface_terrain");
  const coordinates = averageCoordinates(selectedRows);
  if (!builtSurface || !coordinates) return null;
  const parcels = [...new Set(selectedRows.map((row) => clean(row.id_parcelle)).filter(Boolean))];
  return {
    id: `data-gouv:${mutationId}`,
    parcelId: parcels.sort().join("+") || mutationId,
    date,
    totalPrice,
    builtSurfaceM2: builtSurface,
    landSurfaceM2: landSurface,
    pricePerM2: totalPrice / builtSurface,
    propertyType:
      segment === "apartment"
        ? "Appartement"
        : segment === "house"
          ? "Maison"
          : segment === "commercial"
            ? "Local commercial"
            : "Immeuble résidentiel",
    segment,
    distanceM: 0,
    latitude: coordinates.lat,
    longitude: coordinates.lng,
  };
}

function uniqueBuiltRows(rows: OfficialDvfRow[]): OfficialDvfRow[] {
  const unique = new Map<string, OfficialDvfRow>();
  for (const row of rows) {
    if (!positive(row.surface_reelle_bati) || !["1", "2", "4"].includes(row.code_type_local)) {
      continue;
    }
    const key = [
      row.id_parcelle,
      row.code_type_local,
      row.surface_reelle_bati,
      row.lot1_numero,
      row.lot2_numero,
      row.nombre_pieces_principales,
    ].join("|");
    if (!unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()];
}

async function fetchOfficialCommuneYear(
  location: DataGouvCommuneLocation,
  year: number,
): Promise<{ ok: boolean; rows: OfficialDvfRow[] }> {
  const url = `${DATA_GOUV_DVF_BASE}/${year}/communes/${location.departmentCode}/${location.code}.csv`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "text/csv", "User-Agent": "immojudis/1.0" },
        cache: "force-cache",
        signal: AbortSignal.timeout(12_000),
      });
      if (response.status === 404) return { ok: true, rows: [] };
      if (response.status === 429 || response.status >= 500) continue;
      if (!response.ok) return { ok: false, rows: [] };
      return { ok: true, rows: parseCsvRecords(await response.text()) };
    } catch {
      if (attempt === 1) return { ok: false, rows: [] };
    }
  }
  return { ok: false, rows: [] };
}

function publishedYears(now: Date): number[] {
  const latestPublishedYear = now.getUTCFullYear() - 1;
  return Array.from({ length: HISTORY_YEARS }, (_, index) => latestPublishedYear - index);
}

function averageCoordinates(rows: OfficialDvfRow[]): { lat: number; lng: number } | null {
  const points = rows
    .map((row) => ({ lat: finite(row.latitude), lng: finite(row.longitude) }))
    .filter(
      (point): point is { lat: number; lng: number } => point.lat != null && point.lng != null,
    );
  if (!points.length) return null;
  return {
    lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
    lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
  };
}

function firstPositive(rows: OfficialDvfRow[], key: string): number | null {
  return rows.map((row) => positive(row[key])).find((value) => value != null) ?? null;
}

function maximumPositive(rows: OfficialDvfRow[], key: string): number | null {
  const values = rows
    .map((row) => positive(row[key]))
    .filter((value): value is number => value != null);
  return values.length ? Math.max(...values) : null;
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function finite(value: string | null | undefined): number | null {
  const parsed = Number.parseFloat((value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: string | null | undefined): number | null {
  const parsed = finite(value);
  return parsed != null && parsed > 0 ? parsed : null;
}
