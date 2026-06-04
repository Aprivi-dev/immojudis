import { createServerFn } from "@tanstack/react-start";
import { setResponseHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

// Analyse de quartier à partir de coordonnées GPS.
// Source : Overpass API (OpenStreetMap) — open data, sans clé.

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

type OsmTags = Record<string, string | undefined>;
type OsmElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: OsmTags;
};

export type Poi = {
  name: string;
  kind: string;
  distanceM: number;
  lat: number;
  lon: number;
};

export type CategoryStats = {
  count: number;
  nearestM: number | null;
  nearestName: string | null;
  samples: Poi[];
};

export type NeighborhoodAnalysis = {
  ok: boolean;
  error: string | null;
  radiusM: number;
  walkScore: number | null;
  categories: {
    transport: CategoryStats;
    education: CategoryStats;
    health: CategoryStats;
    food: CategoryStats;
    leisure: CategoryStats;
    daily: CategoryStats;
  };
};

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function labelFor(tags: OsmTags): string {
  const t = tags;
  if (t.amenity === "school") return "École";
  if (t.amenity === "kindergarten") return "Crèche";
  if (t.amenity === "college") return "Collège";
  if (t.amenity === "university") return "Université";
  if (t.amenity === "pharmacy") return "Pharmacie";
  if (t.amenity === "hospital") return "Hôpital";
  if (t.amenity === "clinic") return "Clinique";
  if (t.amenity === "doctors") return "Médecin";
  if (t.amenity === "dentist") return "Dentiste";
  if (t.amenity === "restaurant") return "Restaurant";
  if (t.amenity === "cafe") return "Café";
  if (t.amenity === "bar") return "Bar";
  if (t.amenity === "bank") return "Banque";
  if (t.amenity === "post_office") return "Bureau de poste";
  if (t.amenity === "marketplace") return "Marché";
  if (t.amenity === "bus_station") return "Gare routière";
  if (t.shop === "supermarket") return "Supermarché";
  if (t.shop === "bakery") return "Boulangerie";
  if (t.shop === "convenience") return "Épicerie";
  if (t.shop === "butcher") return "Boucherie";
  if (t.shop) return "Commerce";
  if (t.leisure === "park") return "Parc";
  if (t.leisure === "garden") return "Jardin";
  if (t.leisure === "playground") return "Aire de jeux";
  if (t.leisure === "sports_centre") return "Centre sportif";
  if (t.leisure === "fitness_centre") return "Salle de sport";
  if (t.leisure === "swimming_pool") return "Piscine";
  if (t.tourism === "museum") return "Musée";
  if (t.amenity === "theatre") return "Théâtre";
  if (t.amenity === "cinema") return "Cinéma";
  if (t.amenity === "library") return "Bibliothèque";
  if (t.railway === "station" || t.railway === "halt") return "Gare";
  if (t.station === "subway" || t.railway === "subway_entrance") return "Métro";
  if (t.railway === "tram_stop") return "Tramway";
  if (t.highway === "bus_stop") return "Arrêt de bus";
  if (t.public_transport === "station") return "Station";
  return "Point d'intérêt";
}

function categoryFor(tags: OsmTags): keyof NeighborhoodAnalysis["categories"] | null {
  const t = tags;
  if (
    t.railway === "station" ||
    t.railway === "halt" ||
    t.railway === "tram_stop" ||
    t.railway === "subway_entrance" ||
    t.station === "subway" ||
    t.highway === "bus_stop" ||
    t.public_transport === "station" ||
    t.amenity === "bus_station"
  )
    return "transport";
  if (
    t.amenity === "school" ||
    t.amenity === "kindergarten" ||
    t.amenity === "college" ||
    t.amenity === "university"
  )
    return "education";
  if (
    t.amenity === "pharmacy" ||
    t.amenity === "hospital" ||
    t.amenity === "clinic" ||
    t.amenity === "doctors" ||
    t.amenity === "dentist"
  )
    return "health";
  if (
    t.shop === "supermarket" ||
    t.shop === "bakery" ||
    t.shop === "convenience" ||
    t.shop === "butcher" ||
    t.shop === "greengrocer" ||
    t.amenity === "marketplace"
  )
    return "food";
  if (
    t.leisure === "park" ||
    t.leisure === "garden" ||
    t.leisure === "playground" ||
    t.leisure === "sports_centre" ||
    t.leisure === "fitness_centre" ||
    t.leisure === "swimming_pool" ||
    t.tourism === "museum" ||
    t.amenity === "theatre" ||
    t.amenity === "cinema" ||
    t.amenity === "library"
  )
    return "leisure";
  if (
    t.amenity === "restaurant" ||
    t.amenity === "cafe" ||
    t.amenity === "bar" ||
    t.amenity === "bank" ||
    t.amenity === "post_office" ||
    (t.shop && t.shop !== "supermarket")
  )
    return "daily";
  return null;
}

function emptyStats(): CategoryStats {
  return { count: 0, nearestM: null, nearestName: null, samples: [] };
}

function emptyResult(radiusM: number, error: string | null): NeighborhoodAnalysis {
  return {
    ok: error === null,
    error,
    radiusM,
    walkScore: null,
    categories: {
      transport: emptyStats(),
      education: emptyStats(),
      health: emptyStats(),
      food: emptyStats(),
      leisure: emptyStats(),
      daily: emptyStats(),
    },
  };
}

async function fetchOverpass(query: string): Promise<OsmElement[]> {
  let lastStatus = "";
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // Overpass requires an identifying User-Agent; without it
          // requests are silently dropped or 429'd.
          "User-Agent": "immojudis/1.0 (neighborhood-insights)",
          Accept: "application/json",
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) {
        lastStatus = `${endpoint} → HTTP ${res.status}`;
        continue;
      }
      const json = (await res.json()) as { elements?: OsmElement[] };
      return json.elements ?? [];
    } catch (err) {
      lastStatus = `${endpoint} → ${(err as Error).message}`;
    }
  }
  throw new Error(`Overpass indisponible (${lastStatus || "no endpoint reachable"})`);
}

const inputSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().min(200).max(2000).default(800),
});

export const getNeighborhoodAnalysis = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => inputSchema.parse(input))
  .handler(async ({ data }): Promise<NeighborhoodAnalysis> => {
    setResponseHeaders(new Headers({ "cache-control": "public, max-age=86400" }));

    const { lat, lng, radiusM } = data;
    const around = `(around:${radiusM},${lat},${lng})`;

    const query = `
      [out:json][timeout:25];
      (
        node["amenity"~"^(school|kindergarten|college|university|pharmacy|hospital|clinic|doctors|dentist|restaurant|cafe|bar|bank|post_office|marketplace|bus_station|theatre|cinema|library)$"]${around};
        node["shop"~"^(supermarket|bakery|convenience|butcher|greengrocer)$"]${around};
        node["leisure"~"^(park|garden|playground|sports_centre|fitness_centre|swimming_pool)$"]${around};
        node["tourism"="museum"]${around};
        node["railway"~"^(station|halt|tram_stop|subway_entrance)$"]${around};
        node["station"="subway"]${around};
        node["highway"="bus_stop"]${around};
        node["public_transport"="station"]${around};
        way["leisure"~"^(park|garden|sports_centre)$"]${around};
      );
      out center tags;
    `;

    let elements: OsmElement[];
    try {
      elements = await fetchOverpass(query);
    } catch (err) {
      console.error("Overpass fetch failed", err);
      return emptyResult(radiusM, "Analyse de quartier temporairement indisponible.");
    }

    const result = emptyResult(radiusM, null);
    const seen = new Set<string>();

    for (const el of elements) {
      const tags = el.tags ?? {};
      const cat = categoryFor(tags);
      if (!cat) continue;
      const elat = el.lat ?? el.center?.lat;
      const elon = el.lon ?? el.center?.lon;
      if (elat == null || elon == null) continue;

      const name = tags.name ?? labelFor(tags);
      const key = `${cat}|${name}|${elat.toFixed(4)}|${elon.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const dist = Math.round(haversineM(lat, lng, elat, elon));
      if (dist > radiusM) continue;

      const poi: Poi = { name, kind: labelFor(tags), distanceM: dist, lat: elat, lon: elon };
      const stats = result.categories[cat];
      stats.count += 1;
      if (stats.nearestM == null || dist < stats.nearestM) {
        stats.nearestM = dist;
        stats.nearestName = name;
      }
      stats.samples.push(poi);
    }

    for (const key of Object.keys(result.categories) as Array<
      keyof NeighborhoodAnalysis["categories"]
    >) {
      result.categories[key].samples.sort((a, b) => a.distanceM - b.distanceM);
      result.categories[key].samples = result.categories[key].samples.slice(0, 3);
    }

    const cats = Object.values(result.categories);
    const covered = cats.filter((c) => c.count > 0).length;
    const diversityScore = (covered / 6) * 50;
    const nearests = cats.map((c) => c.nearestM).filter((d): d is number => d != null);
    const avgNearest = nearests.length
      ? nearests.reduce((s, d) => s + d, 0) / nearests.length
      : radiusM;
    const proximityScore = Math.max(0, 50 - (avgNearest / radiusM) * 50);
    result.walkScore = Math.round(Math.min(100, diversityScore + proximityScore));

    return result;
  });
