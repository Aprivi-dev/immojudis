import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import {
  getSupabase,
  hasSupabaseAuthHint,
  onSupabaseClient,
  SUPABASE_AUTH_STORAGE_KEY,
  type SupabaseBrowserClient,
} from "@/integrations/supabase/lazy";
import type { AccountProfile } from "@/lib/account";
import { profileFromUserMetadata } from "@/lib/account";

// Share only concurrent reads. Settled results are never cached across auth events.
const pendingUsers = new Map<string, ReturnType<SupabaseBrowserClient["auth"]["getUser"]>>();
const pendingProfiles = new Map<string, Promise<AccountProfile | null>>();

function concurrentRead<T>(pending: Map<string, Promise<T>>, key: string, read: () => Promise<T>) {
  const existing = pending.get(key);
  if (existing) return existing;
  const request = read().finally(() => {
    if (pending.get(key) === request) pending.delete(key);
  });
  pending.set(key, request);
  return request;
}

export type AuthState = ReturnType<typeof useVerifiedAuth>;

// État rendu par le serveur et par le premier rendu d'hydratation : identité en cours de vérification.
const INITIAL_AUTH_STATE: Readonly<AuthState> = Object.freeze({
  session: null,
  user: null,
  profile: null,
  loading: true,
  authError: null,
});

export type AuthStore = {
  getSnapshot: () => AuthState;
  subscribe: (listener: () => void) => () => void;
  publish: (next: AuthState) => void;
};

// L'état d'authentification est partagé par un magasin externe, et non par la valeur du contexte.
// Le contexte ne porte que ce magasin, dont l'identité ne change jamais. Une valeur de contexte qui
// change (ici `loading`, vrai puis faux dès le premier effet) force React à abandonner le HTML
// serveur de toute frontière Suspense pas encore hydratée (celle de `loading.tsx`, tant que son
// code n'est pas arrivé) et à la refaire côté client, sous le squelette. Un magasin ne réveille que
// les composants déjà montés ; les autres lisent l'état courant en s'hydratant.
export function createAuthStore(): AuthStore {
  let state = INITIAL_AUTH_STATE;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(next) {
      if (
        next.session === state.session &&
        next.user === state.user &&
        next.profile === state.profile &&
        next.loading === state.loading &&
        next.authError === state.authError
      )
        return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

export const AuthContext = createContext<AuthStore | null>(null);

const subscribeNever = () => () => {};
const initialAuthState = () => INITIAL_AUTH_STATE;

export function useAuth() {
  const store = useContext(AuthContext);
  const standalone = useVerifiedAuth(store === null);
  const shared = useSyncExternalStore(
    store?.subscribe ?? subscribeNever,
    store?.getSnapshot ?? initialAuthState,
    initialAuthState,
  );
  return store === null ? standalone : shared;
}

// AppProviders keeps a single verified identity across client-side navigation.
// Standalone consumers still work outside the application provider.
export function useVerifiedAuth(enabled = true, routeKey?: string) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const previousRouteRef = useRef(routeKey);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let verification = 0;
    let verifiedUserId: string | undefined;
    let currentSession: Session | null | undefined;

    // Le client n'est branché qu'une fois chargé (voir `attach`) : un visiteur anonyme n'en charge pas.
    let supabase: SupabaseBrowserClient;
    let attached = false;
    let stopWatching: (() => void) | undefined;
    let stopWatchingAnonymous: (() => void) | undefined;

    async function fetchProfile(nextUser: User): Promise<AccountProfile | null> {
      const { data, error } = await supabase
        .from("user_profiles")
        .select(
          "user_id,email,full_name,account_type,account_tier,user_role,professional_role,organization_name,professional_status,created_at,updated_at",
        )
        .eq("user_id", nextUser.id)
        .maybeSingle();

      if (error) {
        console.warn("Profil utilisateur indisponible, fallback user_metadata.", error.message);
        return profileFromUserMetadata(nextUser);
      }

      return (data as AccountProfile | null) ?? profileFromUserMetadata(nextUser);
    }

    async function verifySession(nextSession: Session | null) {
      currentSession = nextSession;
      const currentVerification = ++verification;
      setAuthError(null);
      if (nextSession?.user.id !== verifiedUserId) {
        setLoading(true);
        setSession(null);
        setUser(null);
        setProfile(null);
      }
      if (!nextSession) {
        verifiedUserId = undefined;
        setSession(null);
        setUser(null);
        setProfile(null);
        setLoading(false);
        return;
      }

      const verificationKey = `${nextSession.user.id}:${nextSession.access_token}`;
      const { data, error } = await concurrentRead(pendingUsers, verificationKey, () =>
        supabase.auth.getUser(),
      ).catch(() => ({ data: { user: null }, error: new Error("Identity unavailable") }));
      if (!active || currentVerification !== verification) return;
      if (error || !data.user || data.user.id !== nextSession.user.id) {
        verifiedUserId = undefined;
        setSession(null);
        setAuthError(
          "Votre session n’a pas pu être vérifiée. Reconnectez-vous pour ouvrir l’annonce.",
        );
        setUser(null);
        setProfile(null);
        setLoading(false);
        return;
      }

      const nextProfile = await concurrentRead(pendingProfiles, verificationKey, () =>
        fetchProfile(data.user!),
      ).catch(() => profileFromUserMetadata(data.user!));
      if (!active || currentVerification !== verification) return;
      verifiedUserId = data.user.id;
      setSession(nextSession);
      setUser(data.user);
      setProfile(nextProfile);
      setLoading(false);
    }

    function attach(client: SupabaseBrowserClient) {
      if (!active || attached) return;
      attached = true;
      supabase = client;
      stopWatchingAnonymous?.();
      const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
        void verifySession(s);
      });
      stopWatching = () => sub.subscription.unsubscribe();

      function readSession() {
        const currentVerification = verification;
        supabase.auth
          .getSession()
          .then(({ data }) => {
            if (active && verification === currentVerification) void verifySession(data.session);
          })
          .catch(() => {
            if (!active || verification !== currentVerification) return;
            setAuthError(
              "Votre session n’a pas pu être vérifiée. Reconnectez-vous pour ouvrir l’annonce.",
            );
            setLoading(false);
          });
      }

      refreshRef.current = () => {
        if (currentSession === undefined) readSession();
        else void verifySession(currentSession);
      };
      readSession();
    }

    function loadClient() {
      getSupabase().then(attach, () => {
        if (!active) return;
        setAuthError(
          "Votre session n’a pas pu être vérifiée. Reconnectez-vous pour ouvrir l’annonce.",
        );
        setLoading(false);
      });
    }

    // Dès qu'un client existe (chargé ici ou par une page : connexion, catalogue…), on le surveille.
    const stopListening = onSupabaseClient(attach);
    if (!attached) {
      if (hasSupabaseAuthHint()) {
        // Session stockée ou retour d'authentification dans l'adresse : comme avant, on la retrouve.
        loadClient();
      } else {
        // Visiteur anonyme : rien à vérifier, on n'attend pas le chargement de supabase-js.
        setLoading(false);
        // Sans client, rien ne synchronise les onglets : une connexion faite dans un autre onglet
        // (événement `storage`) ou un indice de session apparu pendant que l'onglet était caché
        // (retour de visibilité) charge le client, qui retrouve alors la session.
        const onStorage = (event: StorageEvent) => {
          if (event.key === SUPABASE_AUTH_STORAGE_KEY && event.newValue !== null) loadClient();
        };
        const onVisibilityChange = () => {
          if (document.visibilityState === "visible" && hasSupabaseAuthHint()) loadClient();
        };
        window.addEventListener("storage", onStorage);
        document.addEventListener("visibilitychange", onVisibilityChange);
        stopWatchingAnonymous = () => {
          window.removeEventListener("storage", onStorage);
          document.removeEventListener("visibilitychange", onVisibilityChange);
          stopWatchingAnonymous = undefined;
        };
      }
    }

    return () => {
      active = false;
      refreshRef.current = null;
      stopListening();
      stopWatching?.();
      stopWatchingAnonymous?.();
    };
  }, [enabled]);

  useEffect(() => {
    if (previousRouteRef.current === routeKey) return;
    previousRouteRef.current = routeKey;
    // Refresh profile changes made outside Auth without blocking the next page
    // or repeating the same request for every mounted consumer.
    refreshRef.current?.();
  }, [routeKey]);

  return { session, user, profile, loading, authError };
}
