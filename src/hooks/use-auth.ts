import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { AccountProfile } from "@/lib/account";
import { profileFromUserMetadata } from "@/lib/account";

// Share only concurrent reads. Settled results are never cached across auth events.
const pendingUsers = new Map<string, ReturnType<typeof supabase.auth.getUser>>();
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

export const AuthContext = createContext<ReturnType<typeof useVerifiedAuth> | null>(null);

export function useAuth() {
  const shared = useContext(AuthContext);
  const standalone = useVerifiedAuth(shared === null);
  return shared ?? standalone;
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

    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      void verifySession(s);
    });

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

    return () => {
      active = false;
      refreshRef.current = null;
      sub.subscription.unsubscribe();
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
