import { createClient } from "@supabase/supabase-js";

const isBrowser = typeof window !== "undefined";

const firstFilledEnv = (...values: Array<string | undefined>) =>
  values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();

const url = firstFilledEnv(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.NEXT_PUBLIC_SUPABASE_URL,
);
const anon = firstFilledEnv(
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

export const isSupabaseConfigured = Boolean(url && anon);

if (!isSupabaseConfigured && isBrowser) {
  console.warn(
    "Supabase non configuré : VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY manquants.",
  );
}

export const supabase = createClient(
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
