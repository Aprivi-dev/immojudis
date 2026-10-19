import "server-only";
import { unstable_cache } from "next/cache";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";
import {
  HEARINGS_RPC_DAYS,
  mapHearingRows,
  type PublicHearing,
  type UpcomingHearingRow,
} from "@/lib/upcoming-hearings";

/**
 * Audiences des 30 prochains jours, lues comme un visiteur anonyme avec la fonction publique
 * `get_public_upcoming_hearings` : la règle de « date sourcée » est celle de l'export agenda, la
 * visibilité celle du catalogue public. Aucune adresse exacte n'en sort.
 *
 * La page est elle-même rafraîchie toutes les heures (ISR) : le cache de données est plus court,
 * pour qu'une audience lue juste avant une régénération ne reste pas affichée deux heures.
 */
export const HEARINGS_DATA_REVALIDATE_SECONDS = 900;
const HEARINGS_CACHE_TAG = "upcoming-hearings";

type HearingsRpcClient = {
  rpc: (
    fn: "get_public_upcoming_hearings",
    args: { p_days: number },
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type UpcomingHearingsRead = {
  hearings: PublicHearing[];
  /** Nombre d'audiences de la fenêtre avant la limite de 1 000 lignes de la base. */
  totalCount: number;
};

async function readUpcomingHearings(): Promise<UpcomingHearingsRead> {
  const client = createPublicSupabaseClient();
  if (!client) throw new Error("Supabase n'est pas configuré côté serveur.");
  const { data, error } = await (client as unknown as HearingsRpcClient).rpc(
    "get_public_upcoming_hearings",
    { p_days: HEARINGS_RPC_DAYS },
  );
  if (error) throw error;
  const rows = (data ?? []) as UpcomingHearingRow[];
  return {
    hearings: mapHearingRows(rows),
    totalCount: Number(rows[0]?.total_count ?? 0) || rows.length,
  };
}

// Une erreur n'est jamais mise en cache (`unstable_cache` ne garde que les succès).
const cachedUpcomingHearings = unstable_cache(readUpcomingHearings, ["upcoming-hearings", "v1"], {
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
 * Vrai quand une lecture en échec doit faire échouer le rendu : en production, hors `next build`.
 * Pendant une régénération ISR, lever l'erreur laisse la dernière bonne page en place (et la
 * régénération est retentée à la requête suivante), au lieu de la remplacer pendant une heure par
 * une page « indisponible ». Pendant `next build` (sans base dans l'environnement de la CI) le
 * build ne doit pas échouer : la page est produite avec son message, en `noindex`.
 */
export function mustFailOnHearingsReadError(
  env: { NODE_ENV?: string; NEXT_PHASE?: string } = process.env,
): boolean {
  return env.NODE_ENV === "production" && env.NEXT_PHASE !== "phase-production-build";
}
