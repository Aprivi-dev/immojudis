import { createClient } from "@supabase/supabase-js";

// Vite inlines VITE_* in the client bundle. On the SSR worker those values
// are not always present — fall back to process.env so a single shared
// module works in both runtimes without "placeholder" requests on first paint.
const isBrowser = typeof window !== "undefined";

function readEnv(): { url: string; anon: string } {
  const viteUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "";
  const viteKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ?? "";
  if (viteUrl && viteKey) return { url: viteUrl, anon: viteKey };
  if (!isBrowser) {
    const procUrl = (process.env.SUPABASE_URL as string | undefined) ?? "";
    const procKey =
      (process.env.SUPABASE_PUBLISHABLE_KEY as string | undefined) ??
      (process.env.SUPABASE_ANON_KEY as string | undefined) ??
      "";
    return { url: viteUrl || procUrl, anon: viteKey || procKey };
  }
  return { url: viteUrl, anon: viteKey };
}

const { url, anon } = readEnv();

export const isSupabaseConfigured = Boolean(url && anon);

if (!isSupabaseConfigured && isBrowser) {
  // eslint-disable-next-line no-console
  console.warn(
    "Lovable Cloud non configuré : VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY manquants.",
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