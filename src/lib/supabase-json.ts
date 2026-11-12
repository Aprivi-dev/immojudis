import type { Json } from "@/integrations/supabase/types";

/**
 * A value as a `jsonb` column stores it: the JSON round trip drops `undefined` fields and turns
 * dates into strings, as the database would, instead of a cast that lets them through unchecked.
 */
export function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
