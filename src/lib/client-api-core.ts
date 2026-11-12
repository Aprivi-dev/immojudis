import { getSupabase, hasSupabaseAuthHint } from "@/integrations/supabase/lazy";

export async function authHeaders(): Promise<HeadersInit> {
  // Sans session stockée (visiteur anonyme), la réponse est connue d'avance : on ne charge pas
  // supabase-js pour la lire (même erreur qu'une session absente).
  if (!hasSupabaseAuthHint()) {
    throw new Error("Connexion requise.");
  }

  const {
    data: { session },
  } = await (await getSupabase()).auth.getSession();

  if (!session?.access_token) {
    throw new Error("Connexion requise.");
  }

  return {
    Authorization: `Bearer ${session.access_token}`,
  };
}

/**
 * L'erreur d'une réponse refusée : son message `error`, ou « Erreur HTTP n ». Le statut accompagne
 * l'erreur pour que userMessage() choisisse la bonne phrase (429, 401, 5xx).
 */
/**
 * Erreur d'une réponse HTTP en échec : le message, le statut et le code de l'enveloppe de l'API
 * (`{ ok: false, error, code }`), que `userMessage` lit pour choisir la phrase montrée.
 */
export function responseError(
  status: number,
  payload: { error?: string | null; code?: unknown } | null,
): Error & { status: number; code?: unknown } {
  return Object.assign(new Error(payload?.error ?? `Erreur HTTP ${status}`), {
    status,
    code: payload?.code,
  });
}

export async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string; code?: unknown })
    | null;
  if (!response.ok) throw responseError(response.status, payload);
  return payload as T;
}
