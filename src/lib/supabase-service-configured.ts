/** Vrai si l'URL Supabase et la clé de service sont configurées. */
export function supabaseServiceRoleConfigured(): boolean {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  return Boolean(url?.trim() && key?.trim());
}
