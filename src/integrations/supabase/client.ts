import { createClient } from "@supabase/supabase-js";
import { publicEnv } from "@/lib/env";
import type { Database } from "./types";

const isBrowser = typeof window !== "undefined";

const { supabaseUrl: url, supabasePublishableKey: anon } = publicEnv();

export const isSupabaseConfigured = Boolean(url && anon);

if (!isSupabaseConfigured && isBrowser) {
  console.warn(
    "Supabase non configuré : NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY manquants.",
  );
}

export const supabase = createClient<Database>(
  url || "https://placeholder.supabase.co",
  anon || "placeholder-key",
  {
    auth: {
      persistSession: isBrowser,
      autoRefreshToken: isBrowser,
      detectSessionInUrl: isBrowser,
      storage: isBrowser ? window.localStorage : undefined,
      // Unique storageKey avoids collisions when multiple Supabase clients
      // (browser + SSR fallback) momentarily coexist during hydration.
      storageKey: "encheres-immo-auth",
    },
    global: {
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
  },
);
