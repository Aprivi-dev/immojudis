/**
 * Le générateur de types Supabase type les arguments des fonctions SQL sans `null`
 * (`p_x: string` ou `p_x?: string`), alors que Postgres accepte `null` pour tout argument
 * non déclaré `STRICT`. Ce helper marque explicitement les appels RPC qui transmettent
 * `null` à un tel argument, sans élargir le type du reste de la signature.
 *
 * À n'utiliser que pour une fonction SQL dont le corps gère bien `null`.
 */
export function nullableRpcArg<T>(value: T | null): T {
  return value as T;
}
