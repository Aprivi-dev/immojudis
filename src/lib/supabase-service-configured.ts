import { serverEnv } from "@/lib/env";

/** Vrai si l'URL Supabase et la clé de service sont configurées (mêmes chaînes que le client de service). */
export function supabaseServiceRoleConfigured(): boolean {
  const { adminUrl, serviceRoleKey } = serverEnv().supabase;
  return Boolean(adminUrl && serviceRoleKey);
}
