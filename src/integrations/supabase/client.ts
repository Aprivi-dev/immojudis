import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anon = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

if (!url || !anon) {
  // eslint-disable-next-line no-console
  console.error("Supabase env vars missing. Check .env (VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY).");
}

export const supabase = createClient(url ?? "", anon ?? "", {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
  },
});