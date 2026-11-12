import "server-only";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isMissingRpcError } from "@/lib/postgrest-errors";

/**
 * Deux indicateurs de lecture pour la page admin « Pilotage », sur les données déjà enregistrées
 * (migration 20261110180000, aucune nouvelle donnée) :
 *
 * - l'ACTIVATION, indépendante du quota de déblocages (qui vaut 0 pendant l'essai) : parmi les comptes
 *   créés sur 7 ou 30 jours, ceux qui ont ouvert une fiche en détail (estimation servie, détail de pépite
 *   ou déblocage), posé un premier favori ou créé une première alerte ;
 * - la part des comptes Découverte qui atteignent les 3 déblocages du mois de Paris (n° 97 : on mesure
 *   avant de toucher au prix de l'offre Analyse).
 *
 * Même protection que le reste du pilotage : jeton de session vérifié, rôle administrateur, lecture avec
 * le client de service. Une mesure impossible (migration pas encore appliquée, panne) vaut `null` et
 * s'affiche « non mesuré », jamais zéro. La règle « moins de 5 » est une règle d'affichage de la page.
 */
type ActivationCount = number | null;

export type ActivationWindow = {
  days: 7 | 30;
  /** Comptes créés dans la fenêtre (hors administrateurs), dont l'adresse est confirmée, et activés. */
  signups: ActivationCount;
  confirmed: ActivationCount;
  activated: ActivationCount;
  /** Le détail par geste : un compte peut en cumuler plusieurs. */
  openedDetail: ActivationCount;
  addedFavorite: ActivationCount;
  createdAlert: ActivationCount;
};

type UnlockThresholdMonth = {
  /** Début du mois de Paris (ISO). */
  monthStart: string | null;
  /** Vrai pour le mois en cours (compté depuis le 1er seulement). */
  partial: boolean;
  /** Comptes Découverte ayant débloqué au moins une vente dans le mois, et au moins trois. */
  unlockedOne: ActivationCount;
  reachedThree: ActivationCount;
};

export type UnlockThreshold = {
  /** Comptes Découverte à cet instant : adresse confirmée, ni administrateur ni accès Analyse (essai compris). */
  discoveryAccounts: ActivationCount;
  months: UnlockThresholdMonth[];
};

export type AdminActivation = {
  generatedAt: string | null;
  windows: ActivationWindow[];
  unlockThreshold: UnlockThreshold;
};

const count = z.number().int().nonnegative().nullish();
const activationSchema = z.object({
  generated_at: z.string().nullish(),
  windows: z.array(
    z.object({
      days: z.number().int(),
      signups: count,
      confirmed: count,
      activated: count,
      opened_detail: count,
      added_favorite: count,
      created_alert: count,
    }),
  ),
});
const thresholdSchema = z.object({
  generated_at: z.string().nullish(),
  discovery_accounts: count,
  months: z.array(
    z.object({
      month_start: z.string().nullish(),
      partial: z.boolean().nullish(),
      unlocked_one: count,
      reached_three: count,
    }),
  ),
});

const WINDOW_DAYS = [7, 30] as const;

function unavailableUnlockThreshold(): UnlockThreshold {
  return {
    discoveryAccounts: null,
    months: [
      { monthStart: null, partial: true, unlockedOne: null, reachedThree: null },
      { monthStart: null, partial: false, unlockedOne: null, reachedThree: null },
    ],
  };
}

/** Réponse quand rien n'a pu être mesuré : tout vaut « non mesuré », jamais zéro. */
export function unavailableActivation(): AdminActivation {
  return {
    generatedAt: null,
    windows: WINDOW_DAYS.map((days) => ({
      days,
      signups: null,
      confirmed: null,
      activated: null,
      openedDetail: null,
      addedFavorite: null,
      createdAlert: null,
    })),
    unlockThreshold: unavailableUnlockThreshold(),
  };
}

/** Lit la réponse JSON de `admin_pilotage_activation`. Une fenêtre absente vaut « non mesuré ». */
export function parseActivationWindows(raw: unknown): {
  generatedAt: string | null;
  windows: ActivationWindow[];
} {
  const summary = activationSchema.parse(raw);
  return {
    generatedAt: summary.generated_at ?? null,
    windows: WINDOW_DAYS.map((days) => {
      const entry = summary.windows.find((window) => window.days === days);
      return {
        days,
        signups: entry?.signups ?? null,
        confirmed: entry?.confirmed ?? null,
        activated: entry?.activated ?? null,
        openedDetail: entry?.opened_detail ?? null,
        addedFavorite: entry?.added_favorite ?? null,
        createdAlert: entry?.created_alert ?? null,
      };
    }),
  };
}

/** Lit la réponse JSON de `admin_pilotage_unlock_threshold` : mois en cours, puis mois précédent. */
export function parseUnlockThreshold(raw: unknown): UnlockThreshold {
  const summary = thresholdSchema.parse(raw);
  const fallback = unavailableUnlockThreshold().months;
  return {
    discoveryAccounts: summary.discovery_accounts ?? null,
    months: fallback.map((empty, index) => {
      const entry = summary.months[index];
      return entry
        ? {
            monthStart: entry.month_start ?? null,
            partial: entry.partial ?? empty.partial,
            unlockedOne: entry.unlocked_one ?? null,
            reachedThree: entry.reached_three ?? null,
          }
        : empty;
    }),
  };
}

/** Comme `getAdminBidCeilings` : jeton et rôle administrateur vérifiés, puis lecture avec le client de service. */
export async function getAdminActivation(
  authToken: string,
  now = new Date(),
): Promise<AdminActivation> {
  await assertAdminAuth(authToken);

  const [activation, threshold] = await Promise.all([
    supabaseAdmin.rpc("admin_pilotage_activation", { p_now: now.toISOString() }),
    supabaseAdmin.rpc("admin_pilotage_unlock_threshold", { p_now: now.toISOString() }),
  ]);
  // Une fonction absente (migration pas encore appliquée) ne mesure rien ; toute autre erreur remonte.
  for (const { error } of [activation, threshold]) {
    if (error && !isMissingRpcError(error)) throw error;
  }
  const fallback = unavailableActivation();
  const windows = activation.error ? null : parseActivationWindows(activation.data);
  return {
    generatedAt: windows?.generatedAt ?? null,
    windows: windows?.windows ?? fallback.windows,
    unlockThreshold: threshold.error
      ? fallback.unlockThreshold
      : parseUnlockThreshold(threshold.data),
  };
}
