import "server-only";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Deux indicateurs de lecture pour la page admin « Pilotage », sur les données déjà enregistrées
 * (migrations 20261110180000 et 20261124100000, aucune nouvelle donnée) :
 *
 * - l'ACTIVATION, indépendante du quota de déblocages (aucun n'était consommé pendant l'essai) : parmi
 *   les comptes créés sur 7 ou 30 jours, ceux qui ont ouvert une fiche en détail (estimation servie,
 *   détail de pépite ou déblocage), posé un premier favori ou créé une première alerte ;
 * - les comptes Découverte qui, dans le mois de Paris, ont pris leur déblocage gratuit (une vente en tout)
 *   ou payé au moins un achat à l'unité, et le nombre de ces achats.
 *
 * Même protection que le reste du pilotage : jeton de session vérifié, rôle administrateur, lecture avec
 * le client de service. Une lecture en échec remonte ; la route de pilotage répond alors
 * `unavailableActivation()`, tout « non mesuré », jamais zéro. La règle « moins de 5 » est une règle d'affichage de la page.
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

type DiscoveryUnlocksMonth = {
  /** Début du mois de Paris (ISO). */
  monthStart: string | null;
  /** Vrai pour le mois en cours (compté depuis le 1er seulement). */
  partial: boolean;
  /** Comptes Découverte ayant pris leur déblocage gratuit dans le mois. */
  unlockedFree: ActivationCount;
  /** Comptes Découverte ayant payé au moins un achat à l'unité dans le mois, et nombre de ces achats. */
  purchasedOne: ActivationCount;
  purchases: ActivationCount;
};

export type DiscoveryUnlocks = {
  /** Comptes Découverte à cet instant : adresse confirmée, ni administrateur ni accès Analyse. */
  discoveryAccounts: ActivationCount;
  months: DiscoveryUnlocksMonth[];
};

export type AdminActivation = {
  generatedAt: string | null;
  windows: ActivationWindow[];
  discoveryUnlocks: DiscoveryUnlocks;
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
const discoveryUnlocksSchema = z.object({
  generated_at: z.string().nullish(),
  discovery_accounts: count,
  months: z.array(
    z.object({
      month_start: z.string().nullish(),
      partial: z.boolean().nullish(),
      unlocked_free: count,
      purchased_one: count,
      purchases: count,
    }),
  ),
});

const WINDOW_DAYS = [7, 30] as const;

function unavailableDiscoveryUnlocks(): DiscoveryUnlocks {
  const empty = { monthStart: null, unlockedFree: null, purchasedOne: null, purchases: null };
  return {
    discoveryAccounts: null,
    months: [
      { ...empty, partial: true },
      { ...empty, partial: false },
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
    discoveryUnlocks: unavailableDiscoveryUnlocks(),
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

/** Lit la réponse JSON de `admin_pilotage_discovery_unlocks` : mois en cours, puis mois précédent. */
export function parseDiscoveryUnlocks(raw: unknown): DiscoveryUnlocks {
  const summary = discoveryUnlocksSchema.parse(raw);
  const fallback = unavailableDiscoveryUnlocks().months;
  return {
    discoveryAccounts: summary.discovery_accounts ?? null,
    months: fallback.map((empty, index) => {
      const entry = summary.months[index];
      return entry
        ? {
            monthStart: entry.month_start ?? null,
            partial: entry.partial ?? empty.partial,
            unlockedFree: entry.unlocked_free ?? null,
            purchasedOne: entry.purchased_one ?? null,
            purchases: entry.purchases ?? null,
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

  const [activation, discoveryUnlocks] = await Promise.all([
    supabaseAdmin.rpc("admin_pilotage_activation", { p_now: now.toISOString() }),
    supabaseAdmin.rpc("admin_pilotage_discovery_unlocks", { p_now: now.toISOString() }),
  ]);
  for (const { error } of [activation, discoveryUnlocks]) {
    if (error) throw error;
  }
  const windows = parseActivationWindows(activation.data);
  return {
    generatedAt: windows.generatedAt,
    windows: windows.windows,
    discoveryUnlocks: parseDiscoveryUnlocks(discoveryUnlocks.data),
  };
}
