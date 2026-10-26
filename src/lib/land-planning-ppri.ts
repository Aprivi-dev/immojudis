import {
  collectionFeatures,
  fetchJson,
  GPU_BASE_URL,
  queryUrl,
} from "@/lib/land-planning-provider";
import { propertiesOf } from "@/lib/land-planning/helpers";

export type PpriPerimeterResult =
  | {
      kind: "ok";
      /** Le point est dans une servitude PM1 d'aléa inondation (`code_alea` = 11). */
      inPerimeter: boolean;
    }
  | { kind: "failure"; code: string }
  | { kind: "rate_limited" };

/** Code d'aléa « inondation » de la servitude PM1 (PPRN) du Géoportail de l'urbanisme. */
const PM1_FLOOD_ALEA_CODE = "11";
const PM1_MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
/** 8 s : le traitement planifié doit tenir dans `maxDuration` (voir `sale-flood-risk-batch.ts`). */
const PM1_TIMEOUT_MS = 8_000;

/**
 * Le point est-il dans le périmètre d'un plan de prévention des risques d'inondation ? Servitude PM1 du GPU
 * (`generateur-sup-s`, API Carto de l'IGN), seulement l'aléa inondation (`code_alea` = 11). C'est le PÉRIMÈTRE du
 * plan, sans couleur : zones rouges et bleues y sont confondues. Seules les coordonnées sont envoyées ; le résultat
 * ne porte ni l'URL ni la réponse (l'appelant ne journalise que `code`).
 */
export async function fetchPpriPerimeter(
  point: { latitude: number; longitude: number },
  options: {
    fetcher?: typeof fetch;
    timeoutMs?: number;
    pace?: () => Promise<void>;
  } = {},
): Promise<PpriPerimeterResult> {
  if (
    !Number.isFinite(point.latitude) ||
    !Number.isFinite(point.longitude) ||
    Math.abs(point.latitude) > 90 ||
    Math.abs(point.longitude) > 180
  ) {
    return { kind: "failure", code: "invalid_position" };
  }
  const url = queryUrl(`${GPU_BASE_URL}/generateur-sup-s`, {
    categorie: "PM1",
    geom: JSON.stringify({ type: "Point", coordinates: [point.longitude, point.latitude] }),
  });
  if (options.pace) await options.pace();
  const response = await fetchJson(url, {
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs ?? PM1_TIMEOUT_MS,
    maxResponseBytes: PM1_MAX_RESPONSE_BYTES,
    refuseRedirect: true,
  });
  if (!response.ok) {
    const { issue } = response;
    if (issue.httpStatus === 429) return { kind: "rate_limited" };
    if (issue.httpStatus) return { kind: "failure", code: `http_${issue.httpStatus}` };
    return { kind: "failure", code: issue.kind === "timeout" ? "timeout" : issue.kind };
  }
  const features = collectionFeatures(response.data);
  if (!features) return { kind: "failure", code: "unexpected_shape" };
  return {
    kind: "ok",
    inPerimeter: features.some((feature) => {
      const alea = propertiesOf(feature).code_alea;
      return String(alea ?? "").trim() === PM1_FLOOD_ALEA_CODE;
    }),
  };
}
