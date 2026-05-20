import { createServerFn } from "@tanstack/react-start";
import { setResponseHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

// ─── DVF (Demandes de Valeurs Foncières) via API Cerema ─────────────────
// Données ouvertes DGFiP, toutes les transactions immobilières de France.
// https://apidf-preprod.cerema.fr/

const CEREMA_BASE = "https://apidf-preprod.cerema.fr/dvf_opendata/geomutations/";

// Mapping property_type → codtypbien Cerema
function codtypbienFor(propertyType: string | null | undefined): string[] {
  if (!propertyType) return ["111", "121"];
  const s = propertyType.toLowerCase();
  if (s.includes("apart") || s.includes("apt") || s.includes("appartement")) return ["121"];
  if (s.includes("house") || s.includes("maison")) return ["111"];
  return ["111", "121"];
}

function bboxAround(lat: number, lng: number, radiusM: number) {
  const dLat = radiusM / 111_000;
  const dLng = radiusM / (111_000 * Math.cos((lat * Math.PI) / 180));
  return {
    xmin: lng - dLng,
    ymin: lat - dLat,
    xmax: lng + dLng,
    ymax: lat + dLat,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

type Mutation = {
  datemut: string;
  anneemut: number;
  valeurfonc: string;
  sbati: string;
  codtypbien: string;
  libtypbien: string;
};

export type MarketEstimate = {
  source: "DVF Cerema";
  radiusM: number;
  yearsBack: number;
  sampleSize: number;
  medianPricePerM2: number | null;
  p25PricePerM2: number | null;
  p75PricePerM2: number | null;
  // Si on a un prix de référence (mise à prix, prix d'adjudication)
  deviationPct: number | null; // <0 = sous le marché, >0 = au-dessus
  recentTransactions: Array<{
    date: string;
    pricePerM2: number;
    surface: number;
    totalPrice: number;
    type: string;
  }>;
};

export type MarketContext = {
  ok: boolean;
  error: string | null;
  estimate: MarketEstimate | null;
};

const inputSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().min(100).max(2000).default(500),
  yearsBack: z.number().min(1).max(5).default(2),
  propertyType: z.string().nullable().optional(),
  pricePerM2Ref: z.number().nullable().optional(), // pour calculer la déviation
});

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export const getMarketEstimate = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => inputSchema.parse(input))
  .handler(async ({ data }): Promise<MarketContext> => {
    // Cache CDN 24h (les données DVF changent au mieux trimestriellement)
    setResponseHeaders(new Headers({ "cache-control": "public, max-age=86400" }));

    const bbox = bboxAround(data.lat, data.lng, data.radiusM);
    const codes = codtypbienFor(data.propertyType);
    const currentYear = new Date().getFullYear();
    const minYear = currentYear - data.yearsBack;

    try {
      // Récupérer en parallèle les années couvertes et les types de bien
      const years: number[] = [];
      for (let y = minYear; y <= currentYear; y++) years.push(y);

      const requests: Array<Promise<Mutation[]>> = [];
      for (const year of years) {
        for (const code of codes) {
          const url =
            `${CEREMA_BASE}?in_bbox=${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax}` +
            `&anneemut=${year}&codtypbien=${code}&page_size=500`;
          requests.push(
            fetch(url, { signal: AbortSignal.timeout(8_000) })
              .then((r) => (r.ok ? r.json() : { features: [] }))
              .then((j: { features?: Array<{ properties: Mutation }> }) =>
                (j.features ?? []).map((f) => f.properties),
              )
              .catch(() => [] as Mutation[]),
          );
        }
      }

      const batches = await Promise.all(requests);
      const all = batches.flat();

      // Calcul du €/m² par transaction avec filtrage des outliers
      const enriched = all
        .map((m) => {
          const price = parseFloat(m.valeurfonc);
          const surf = parseFloat(m.sbati);
          if (!Number.isFinite(price) || !Number.isFinite(surf)) return null;
          if (surf < 10 || price < 10_000) return null;
          const ppm2 = price / surf;
          if (ppm2 < 500 || ppm2 > 25_000) return null; // outliers
          return {
            date: m.datemut,
            pricePerM2: ppm2,
            surface: surf,
            totalPrice: price,
            type: m.libtypbien,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      if (enriched.length < 3) {
        return {
          ok: true,
          error: null,
          estimate: {
            source: "DVF Cerema",
            radiusM: data.radiusM,
            yearsBack: data.yearsBack,
            sampleSize: enriched.length,
            medianPricePerM2: null,
            p25PricePerM2: null,
            p75PricePerM2: null,
            deviationPct: null,
            recentTransactions: enriched.slice(0, 5),
          },
        };
      }

      const sortedPpm2 = enriched.map((e) => e.pricePerM2).sort((a, b) => a - b);
      const med = median(sortedPpm2);
      const p25 = percentile(sortedPpm2, 0.25);
      const p75 = percentile(sortedPpm2, 0.75);

      const deviationPct =
        data.pricePerM2Ref != null && data.pricePerM2Ref > 0
          ? ((data.pricePerM2Ref - med) / med) * 100
          : null;

      // 5 transactions les plus récentes pour transparence
      const recent = [...enriched]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 5);

      return {
        ok: true,
        error: null,
        estimate: {
          source: "DVF Cerema",
          radiusM: data.radiusM,
          yearsBack: data.yearsBack,
          sampleSize: enriched.length,
          medianPricePerM2: Math.round(med),
          p25PricePerM2: Math.round(p25),
          p75PricePerM2: Math.round(p75),
          deviationPct,
          recentTransactions: recent,
        },
      };
    } catch (err) {
      console.error("DVF fetch failed", err);
      return {
        ok: false,
        error: "Estimation de marché temporairement indisponible.",
        estimate: null,
      };
    }
  });