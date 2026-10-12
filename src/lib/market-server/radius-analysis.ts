import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  mutationSegmentFromCode,
  resolveMarketPropertySegment,
  type MarketEngineCandidate,
  type MarketPropertySegment,
} from "@/lib/market-estimation-engine";
import { fetchDataGouvDvfCommune } from "@/lib/dvf-data-gouv";
import type {
  CommuneInfo,
  MarketAddressSale,
  RadiusAnalysis,
  StoredDvfRow,
} from "@/lib/market-server/types";
import {
  HISTORY_YEARS,
  MIN_BUILT_SURFACE,
  PAGE_CACHE_TTL_MS,
  STORED_DVF_LIMIT,
  storedDvfCache,
} from "@/lib/market-server/constants";
import {
  bboxAround,
  featureCentroid,
  haversineMeters,
  pointInFeature,
} from "@/lib/market-server/geometry";
import { finiteFloat, finiteNumber, monthDistance } from "@/lib/market-server/numbers";
import { fetchDvfYear, parcelKey } from "@/lib/market-server/sources";

export async function analyzeAtRadius(
  lat: number,
  lng: number,
  radiusM: number,
  segment: Exclude<MarketPropertySegment, "unsupported">,
  commune: CommuneInfo | null,
): Promise<RadiusAnalysis> {
  const stored = await analyzeStoredDvfAtRadius(lat, lng, radiusM, segment);
  if (stored) return stored;

  const dataGouv = await analyzeDataGouvDvfAtRadius(lat, lng, radiusM, segment, commune);
  if (dataGouv && (dataGouv.collectionComplete || dataGouv.candidates.length > 0)) {
    return dataGouv;
  }

  const bbox = bboxAround(lat, lng, radiusM);
  const currentYear = new Date().getFullYear();
  const years: number[] = [];
  for (let y = currentYear; y > currentYear - HISTORY_YEARS; y -= 1) years.push(y);

  const batches = await Promise.all(years.map((year) => fetchDvfYear(bbox, year, segment)));
  const features = batches.flatMap((batch) => batch.features);
  const missingYears = years.filter((_, index) => !batches[index].complete);
  const collectionComplete = missingYears.length === 0;

  // Parcelle du bien : celle dont le polygone contient le point, sinon la plus
  // proche par centroïde (≤ 25 m).
  let subjectKey: string | null = null;
  let nearestKey: string | null = null;
  let nearestDist = Infinity;
  for (const feature of features) {
    const key = parcelKey(feature.properties);
    if (!key) continue;
    if (subjectKey == null && pointInFeature(feature.geometry, lng, lat)) subjectKey = key;
    const centroid = featureCentroid(feature.geometry);
    if (centroid) {
      const dist = haversineMeters(lat, lng, centroid[1], centroid[0]);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestKey = key;
      }
    }
  }
  if (subjectKey == null && nearestDist <= 25) subjectKey = nearestKey;

  const candidates: MarketEngineCandidate[] = [];
  const addressMutations: MarketAddressSale[] = [];
  let totalNearby = 0;

  for (const feature of features) {
    const props = feature.properties;
    if (props.libnatmut && props.libnatmut !== "Vente") continue;
    const key = parcelKey(props);
    if (!key) continue;
    const centroid = featureCentroid(feature.geometry);
    if (!centroid) continue;
    const distanceM = haversineMeters(lat, lng, centroid[1], centroid[0]);
    const candidateSegment = mutationSegmentFromCode(props.codtypbien);
    if (candidateSegment !== segment) continue;
    if ((segment === "apartment" || segment === "house") && (props.nblocmut ?? 1) !== 1) {
      continue;
    }
    if (segment === "land" && (props.nblocmut ?? 0) > 0) continue;
    const builtSurface = finiteFloat(props.sbati);
    const landSurface = finiteFloat(props.sterr);
    const primarySurface = segment === "land" ? landSurface : builtSurface;
    const price = parseFloat(props.valeurfonc ?? "");
    const date = props.datemut ?? "";
    const pricePerM2 =
      Number.isFinite(price) && primarySurface != null && primarySurface > 0
        ? price / primarySurface
        : null;

    // Historique parcellaire du même segment que le bien étudié.
    if (subjectKey && key === subjectKey && date) {
      addressMutations.push({
        date,
        totalPrice: Number.isFinite(price) ? price : 0,
        surface: primarySurface,
        pricePerM2: pricePerM2 == null ? null : Math.round(pricePerM2),
        type: props.libtypbien ?? "—",
      });
    }

    if (distanceM > radiusM) continue;
    totalNearby += 1;

    if (!Number.isFinite(price) || price <= 0 || !primarySurface || !pricePerM2) continue;
    if (segment !== "land" && primarySurface < MIN_BUILT_SURFACE) continue;
    if (key === subjectKey) continue; // l'adresse est traitée à part

    candidates.push({
      id: props.idmutinvar ?? `${key}:${date}:${price}`,
      parcelId: key,
      date,
      totalPrice: price,
      builtSurfaceM2: builtSurface,
      landSurfaceM2: landSurface,
      pricePerM2,
      propertyType: props.libtypbien ?? "—",
      segment,
      distanceM: Math.round(distanceM),
      latitude: centroid[1],
      longitude: centroid[0],
    });
  }

  // Une vente par parcelle évite qu'un immeuble ou programme très actif domine l'échantillon.
  const latestByParcel = new Map<string, MarketEngineCandidate>();
  for (const sale of candidates) {
    const existing = latestByParcel.get(sale.parcelId);
    if (!existing || sale.date > existing.date) latestByParcel.set(sale.parcelId, sale);
  }

  return {
    source: "DVF Cerema",
    candidates: [...latestByParcel.values()],
    addressMutations,
    totalNearby,
    collectionComplete,
    missingYears,
  };
}

async function analyzeDataGouvDvfAtRadius(
  lat: number,
  lng: number,
  radiusM: number,
  segment: Exclude<MarketPropertySegment, "unsupported">,
  commune: CommuneInfo | null,
): Promise<RadiusAnalysis | null> {
  if (!commune?.departmentCode) return null;
  const collection = await fetchDataGouvDvfCommune({
    location: { code: commune.code, departmentCode: commune.departmentCode },
    segment,
  });
  if (!collection) return null;

  const normalized = collection.candidates
    .map((candidate) => {
      const latitude = finiteNumber(candidate.latitude);
      const longitude = finiteNumber(candidate.longitude);
      if (latitude == null || longitude == null) return null;
      return {
        ...candidate,
        distanceM: Math.round(haversineMeters(lat, lng, latitude, longitude)),
      };
    })
    .filter((candidate): candidate is MarketEngineCandidate => candidate != null)
    .filter((candidate) => candidate.distanceM <= radiusM);
  const nearest = [...normalized].sort((a, b) => a.distanceM - b.distanceM)[0];
  const subjectParcel = nearest?.distanceM <= 25 ? nearest.parcelId : null;
  const addressMutations = normalized
    .filter((candidate) => subjectParcel && candidate.parcelId === subjectParcel)
    .map((candidate) => ({
      date: candidate.date,
      totalPrice: candidate.totalPrice,
      surface: primarySurfaceForStoredCandidate(segment, candidate),
      pricePerM2: Math.round(candidate.pricePerM2),
      type: candidate.propertyType,
    }));
  const latestByParcel = new Map<string, MarketEngineCandidate>();
  for (const candidate of normalized) {
    if (subjectParcel && candidate.parcelId === subjectParcel) continue;
    const current = latestByParcel.get(candidate.parcelId);
    if (!current || candidate.date > current.date)
      latestByParcel.set(candidate.parcelId, candidate);
  }
  return {
    source: "DVF data.gouv",
    candidates: [...latestByParcel.values()],
    addressMutations,
    totalNearby: normalized.length,
    collectionComplete: collection.complete,
    missingYears: collection.missingYears,
  };
}

async function analyzeStoredDvfAtRadius(
  lat: number,
  lng: number,
  radiusM: number,
  segment: Exclude<MarketPropertySegment, "unsupported">,
): Promise<RadiusAnalysis | null> {
  if (!storedDvfConfigured()) return null;
  const cacheKey = `${lat.toFixed(4)}:${lng.toFixed(4)}:${radiusM}:${segment}`;
  const cached = storedDvfCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const { data: latestBatch, error: batchError } = await supabaseAdmin
      .from("dvf_import_batches")
      .select("status,imported_rows,period_end")
      .eq("status", "completed")
      .gt("imported_rows", 0)
      .order("period_end", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (batchError || !latestBatch?.period_end || !recentEnough(latestBatch.period_end, 18)) {
      storedDvfCache.set(cacheKey, { expiresAt: Date.now() + 60_000, value: null });
      return null;
    }

    const minimumDate = new Date();
    minimumDate.setUTCFullYear(minimumDate.getUTCFullYear() - HISTORY_YEARS);
    let data: unknown;
    let error: { message?: string } | null = null;
    // `rpc` est absent des doubles de test minimalistes de supabaseAdmin.
    if (typeof supabaseAdmin.rpc === "function") {
      const result = await supabaseAdmin.rpc("search_dvf_market_comparables", {
        p_latitude: lat,
        p_longitude: lng,
        p_radius_m: radiusM,
        p_minimum_date: minimumDate.toISOString().slice(0, 10),
        p_segment: segment,
        p_limit: STORED_DVF_LIMIT,
      });
      data = result.data;
      error = result.error;
    } else {
      // Fallback retained for local tests and during a rolling deployment where
      // application code can briefly precede the database migration.
      const bbox = bboxAround(lat, lng, radiusM);
      const result = await supabaseAdmin
        .from("dvf_transactions")
        .select(
          "id,source_mutation_id,sale_date,mutation_nature,total_price_eur,built_surface_m2,land_surface_m2,price_per_m2,property_type,dvf_property_type_code,parcel_id,latitude,longitude",
        )
        .gte("sale_date", minimumDate.toISOString().slice(0, 10))
        .gte("latitude", bbox.ymin)
        .lte("latitude", bbox.ymax)
        .gte("longitude", bbox.xmin)
        .lte("longitude", bbox.xmax)
        .order("sale_date", { ascending: false })
        .limit(STORED_DVF_LIMIT);
      data = result.data;
      error = result.error;
    }
    if (error) throw error;
    const rows = (data ?? []) as StoredDvfRow[];
    if (!rows.length) {
      storedDvfCache.set(cacheKey, { expiresAt: Date.now() + 60_000, value: null });
      return null;
    }

    const normalized = rows
      .map((row) => storedDvfCandidate(row, { lat, lng, segment }))
      .filter((candidate): candidate is MarketEngineCandidate => candidate != null)
      .filter((candidate) => candidate.distanceM <= radiusM);
    if (!normalized.length) {
      storedDvfCache.set(cacheKey, { expiresAt: Date.now() + 60_000, value: null });
      return null;
    }

    const nearest = [...normalized].sort((a, b) => a.distanceM - b.distanceM)[0];
    const subjectParcel = nearest?.distanceM <= 25 ? nearest.parcelId : null;
    const addressMutations = normalized
      .filter((candidate) => subjectParcel && candidate.parcelId === subjectParcel)
      .map((candidate) => ({
        date: candidate.date,
        totalPrice: candidate.totalPrice,
        surface: primarySurfaceForStoredCandidate(segment, candidate),
        pricePerM2: Math.round(candidate.pricePerM2),
        type: candidate.propertyType,
      }));
    const latestByParcel = new Map<string, MarketEngineCandidate>();
    for (const candidate of normalized) {
      if (subjectParcel && candidate.parcelId === subjectParcel) continue;
      const current = latestByParcel.get(candidate.parcelId);
      if (!current || candidate.date > current.date)
        latestByParcel.set(candidate.parcelId, candidate);
    }
    const value: RadiusAnalysis = {
      source: "DVF normalisé",
      candidates: [...latestByParcel.values()],
      addressMutations,
      totalNearby: normalized.length,
      collectionComplete: rows.length < STORED_DVF_LIMIT,
      missingYears: [],
    };
    storedDvfCache.set(cacheKey, { expiresAt: Date.now() + PAGE_CACHE_TTL_MS, value });
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[dvf] corpus normalisé indisponible: ${message}`);
    storedDvfCache.set(cacheKey, { expiresAt: Date.now() + 60_000, value: null });
    return null;
  }
}

function storedDvfCandidate(
  row: StoredDvfRow,
  reference: {
    lat: number;
    lng: number;
    segment: Exclude<MarketPropertySegment, "unsupported">;
  },
): MarketEngineCandidate | null {
  const latitude = finiteNumber(row.latitude);
  const longitude = finiteNumber(row.longitude);
  const totalPrice = finiteNumber(row.total_price_eur);
  const builtSurfaceM2 = finiteNumber(row.built_surface_m2);
  const landSurfaceM2 = finiteNumber(row.land_surface_m2);
  const rowSegment =
    mutationSegmentFromCode(row.dvf_property_type_code) ??
    resolveMarketPropertySegment({ propertyType: row.property_type });
  if (
    latitude == null ||
    longitude == null ||
    totalPrice == null ||
    rowSegment !== reference.segment ||
    (row.mutation_nature && row.mutation_nature !== "Vente")
  ) {
    return null;
  }
  const primarySurface = reference.segment === "land" ? landSurfaceM2 : builtSurfaceM2;
  if (!primarySurface || (reference.segment !== "land" && primarySurface < MIN_BUILT_SURFACE)) {
    return null;
  }
  const pricePerM2 = totalPrice / primarySurface;
  const rpcDistance = finiteNumber(row.distance_m);
  return {
    id: row.source_mutation_id || row.id,
    parcelId: row.parcel_id || row.id,
    date: row.sale_date,
    totalPrice,
    builtSurfaceM2,
    landSurfaceM2,
    pricePerM2,
    propertyType: row.property_type ?? row.dvf_property_type_code ?? "—",
    segment: reference.segment,
    distanceM:
      rpcDistance == null
        ? Math.round(haversineMeters(reference.lat, reference.lng, latitude, longitude))
        : Math.round(rpcDistance),
    latitude,
    longitude,
  };
}

function primarySurfaceForStoredCandidate(
  segment: Exclude<MarketPropertySegment, "unsupported">,
  candidate: MarketEngineCandidate,
): number | null {
  return segment === "land" ? candidate.landSurfaceM2 : candidate.builtSurfaceM2;
}

function storedDvfConfigured(): boolean {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  return Boolean(url?.trim() && key?.trim());
}

export function recentEnough(dateValue: string, maxAgeMonths: number): boolean {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return false;
  return monthDistance(date, new Date()) <= maxAgeMonths;
}
