import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

/**
 * Accès différé au client Supabase du navigateur.
 *
 * `@supabase/supabase-js` pèse lourd et la plupart des visiteurs des pages publiques (accueil,
 * guides, articles) n'ont ni session ni action à faire : le module `./client` ne doit donc pas
 * entrer dans le JavaScript commun. Les modules qui en ont besoin sur toutes les pages (fournisseur
 * d'authentification, en-tête) passent par ce fichier, qui ne contient aucun import de
 * `supabase-js` à l'exécution ; les pages qui en ont besoin de toute façon continuent d'importer
 * `./client` directement.
 */

export type SupabaseBrowserClient = SupabaseClient<Database>;

/** Clé du stockage local où `supabase-js` garde la session (voir `./client`). */
export const SUPABASE_AUTH_STORAGE_KEY = "encheres-immo-auth";

let created: SupabaseBrowserClient | null = null;
const createdListeners = new Set<(client: SupabaseBrowserClient) => void>();
let loading: Promise<SupabaseBrowserClient> | null = null;

/** Appelé par `./client` dès que le client existe, quelle que soit la façon dont il a été chargé. */
export function announceSupabaseClient(client: SupabaseBrowserClient): void {
  created = client;
  for (const listener of [...createdListeners]) listener(client);
}

/**
 * Prévient dès que le client existe (tout de suite s'il existe déjà). Sert au fournisseur
 * d'authentification : un visiteur anonyme n'a pas de client à surveiller jusqu'à ce qu'une page
 * (connexion, catalogue…) en charge un, et il faut alors s'y abonner pour voir la connexion.
 */
export function onSupabaseClient(listener: (client: SupabaseBrowserClient) => void): () => void {
  if (created) {
    listener(created);
    return () => {};
  }
  createdListeners.add(listener);
  return () => {
    createdListeners.delete(listener);
  };
}

/** Le client, chargé au premier appel (import dynamique mis en cache). */
export function getSupabase(): Promise<SupabaseBrowserClient> {
  if (created) return Promise.resolve(created);
  loading ??= import("./client").then(
    (module) => module.supabase as SupabaseBrowserClient,
    (error: unknown) => {
      // Un échec de chargement (réseau) ne doit pas rester en mémoire : le prochain appel réessaie.
      loading = null;
      throw error;
    },
  );
  return loading;
}

/**
 * Faut-il charger Supabase dès l'arrivée sur la page ? Oui s'il y a une session stockée ou si
 * l'adresse porte un retour d'authentification (lien de confirmation ou de réinitialisation,
 * retour OAuth) que `detectSessionInUrl` doit lire. Dans le doute (stockage inaccessible), oui :
 * c'est le comportement d'avant. Un faux positif ne coûte que le chargement.
 */
export function hasSupabaseAuthHint(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.localStorage.getItem(SUPABASE_AUTH_STORAGE_KEY) !== null) return true;
  } catch {
    return true;
  }
  const { hash, search } = window.location;
  return /(?:^|[#?&])(?:access_token|refresh_token|error_description|error_code|code|token_hash)=/u.test(
    `${hash}&${search}`,
  );
}

/** Réservé aux tests : remet à zéro l'état du module. */
export function resetSupabaseLazyForTests(): void {
  created = null;
  loading = null;
  createdListeners.clear();
}
