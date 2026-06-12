import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { AccountProfile } from "@/lib/account";
import { profileFromUserMetadata } from "@/lib/account";

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function fetchProfile(nextUser: User): Promise<AccountProfile | null> {
      const { data, error } = await supabase
        .from("user_profiles")
        .select(
          "user_id,email,full_name,account_type,professional_role,organization_name,professional_status,created_at,updated_at",
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
      setSession(nextSession);
      if (!nextSession) {
        setUser(null);
        setProfile(null);
        setLoading(false);
        return;
      }

      const { data, error } = await supabase.auth.getUser();
      if (!active) return;
      if (error || !data.user) {
        setUser(null);
        setProfile(null);
        setLoading(false);
        return;
      }

      const nextProfile = await fetchProfile(data.user);
      if (!active) return;
      setUser(data.user);
      setProfile(nextProfile);
      setLoading(false);
    }

    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      void verifySession(s);
    });

    supabase.auth.getSession().then(({ data }) => {
      void verifySession(data.session);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { session, user, profile, loading };
}
