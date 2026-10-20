import "server-only";
import { unstable_cache } from "next/cache";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isProductionRuntime } from "@/lib/runtime-phase";
import {
  HEARINGS_RPC_DAYS,
  mapHearingRows,
  type PublicHearing,
  type UpcomingHearingRow,
} from "@/lib/upcoming-hearings";

/**
 * Audiences des 30 prochains jours, lues côté serveur (`service_role`) avec la fonction
 * `get_public_upcoming_hearings` : la règle de « date sourcée » est celle de l'export agenda, la
 * visibilité celle du catalogue public. Aucune adresse exacte n'en sort, ni adresse source (clés
 * opaques). La fonction n'est plus ouverte à `anon` : la limite de 3 s des requêtes anonymes ne
 * s'applique pas, et elle ne rend qu'un document (pas de limite de lignes de PostgREST).
 *
 * La page est elle-même rafraîchie toutes les heures (ISR) : le cache de données est plus court,
 * pour qu'une audience lue juste avant une régénération ne reste pas affichée deux heures.
 */
export const HEARINGS_DATA_REVALIDATE_SECONDS = 900;
export const HEARINGS_CACHE_TAG = "upcoming-hearings";

type HearingsRpcClient = {
  rpc: (
    fn: "get_public_upcoming_hearings",
    args: { p_days: number },
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type UpcomingHearingsRead = {
  hearings: PublicHearing[];
  /** Nombre d'audiences de la fenêtre avant le plafond de la base (5 000). */
  totalCount: number;
};

/**
 * Réponse de la base : un document `{ total_count, hearings }`, ou (avant la migration
 * 20261029100100) un tableau de lignes qui portent chacune `total_count`.
 */
function parseHearingsPayload(data: unknown): { rows: UpcomingHearingRow[]; total: number } {
  if (Array.isArray(data)) {
    const rows = data as UpcomingHearingRow[];
    return { rows, total: Number(rows[0]?.total_count ?? 0) || rows.length };
  }
  const document = data as { hearings?: unknown; total_count?: number | string } | null;
  if (document && Array.isArray(document.hearings)) {
    const rows = document.hearings as UpcomingHearingRow[];
    return { rows, total: Number(document.total_count ?? 0) || rows.length };
  }
  throw new Error("Réponse inattendue de get_public_upcoming_hearings.");
}

async function readUpcomingHearings(): Promise<UpcomingHearingsRead> {
  const { data, error } = await (supabaseAdmin as unknown as HearingsRpcClient).rpc(
    "get_public_upcoming_hearings",
    { p_days: HEARINGS_RPC_DAYS },
  );
  if (error) throw error;
  const { rows, total } = parseHearingsPayload(data ?? []);
  return { hearings: mapHearingRows(rows), totalCount: total };
}

// Une erreur n'est jamais mise en cache (`unstable_cache` ne garde que les succès). La clé change avec
// la forme de la réponse : un ancien résultat en cache n'est pas relu.
const cachedUpcomingHearings = unstable_cache(readUpcomingHearings, ["upcoming-hearings", "v2"], {
  revalidate: HEARINGS_DATA_REVALIDATE_SECONDS,
  tags: [HEARINGS_CACHE_TAG],
});

export type UpcomingHearingsResult =
  | ({ status: "ok" } & UpcomingHearingsRead)
  | { status: "error" };

/** Ne lève pas : la fonction peut manquer (migration pas encore appliquée) ou la base être en panne. */
export async function tryLoadUpcomingHearings(): Promise<UpcomingHearingsResult> {
  try {
    return { status: "ok", ...(await cachedUpcomingHearings()) };
  } catch (error) {
    console.warn("[audiences] Audiences à venir indisponibles:", error);
    return { status: "error" };
  }
}

/**
 * Vrai quand une lecture en échec doit faire échouer le rendu : en production, hors `next build`
 * (règle partagée avec `/sales`, voir `isProductionRuntime`). Pendant une régénération ISR, lever
 * l'erreur laisse la dernière bonne page en place (et la régénération est retentée à la requête
 * suivante), au lieu de la remplacer pendant une heure par une page « indisponible ». Pendant
 * `next build` (sans base dans l'environnement de la CI) le build ne doit pas échouer : la page est
 * produite avec son message, en `noindex`.
 */
export function mustFailOnHearingsReadError(
  env: { NODE_ENV?: string; NEXT_PHASE?: string } = process.env,
): boolean {
  return isProductionRuntime(env);
}
