import { getSupabase, hasSupabaseAuthHint } from "@/integrations/supabase/lazy";
import { NETWORK_ERROR_MESSAGE, TIMEOUT_ERROR_MESSAGE } from "@/lib/fetch-error-messages";

export async function authHeaders(): Promise<Record<string, string>> {
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

/**
 * Délai d'une lecture ou d'un appel d'administration : 30 s, la durée maximale des routes
 * d'administration (`maxDuration = 30`). Une écriture ou un fichier hors administration (création
 * d'un rapport, export PDF ou CSV) n'a pas de délai côté navigateur, comme avant `apiRequest` : sa
 * route n'est bornée que par l'hébergeur, et l'abandonner côté navigateur laisserait l'écriture se
 * faire sans que la page le sache. `timeoutMs` impose un délai précis.
 */
const API_TIMEOUT_MS = 30_000;

export type ApiRequestOptions = {
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
  /** Corps de la requête, envoyé en JSON. */
  body?: unknown;
  /** Route ouverte aux visiteurs : la requête part sans jeton, sans charger supabase-js. */
  anonymous?: boolean;
  /** Délai précis (durée maximale de la route), à la place de la règle de `API_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Abandon décidé par l'appelant (lecture que React Query annule), en plus du délai. */
  signal?: AbortSignal;
};

/**
 * La réponse d'une route de l'API, sans la lire (statut que l'appelant interprète). Le jeton du
 * compte, l'en-tête JSON du corps et le délai sont posés ici, pour tous les appels.
 */
export const apiFetch: (path: string, options?: ApiRequestOptions) => Promise<Response> = send;

async function send(
  path: string,
  options: ApiRequestOptions & {
    /** Réponse fichier (PDF, CSV, agenda), posée par `apiDownload` : sans délai hors administration. */
    file?: boolean;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = options.anonymous ? {} : await authHeaders();
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  // Hors du `try` : une valeur qui ne se sérialise pas (BigInt, référence circulaire) lève sa propre
  // `TypeError`, qui n'est pas une coupure réseau.
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const ms =
    options.timeoutMs ??
    (path.startsWith("/api/admin/") || !(options.method || options.file) ? API_TIMEOUT_MS : 0);
  let { signal } = options;
  let deadline: AbortSignal | undefined;
  if (ms) {
    const timeout = AbortSignal.timeout(ms);
    // `AbortSignal.any` manque aux plus anciens navigateurs pris en charge (Safari 16.4 à 17.3) :
    // l'abandon de l'appelant y reste, sans délai.
    signal = signal ? (AbortSignal.any?.([signal, timeout]) ?? signal) : timeout;
    if (signal !== options.signal) deadline = timeout;
  }
  try {
    return await fetch(path, { method: options.method, headers, body, signal });
  } catch (error) {
    // Une annulation voulue (page quittée, lecture que React Query abandonne) reste ce qu'elle
    // est : React Query l'ignore, aucun message n'est à montrer.
    if (options.signal?.aborted) throw error;
    // Le délai : `TimeoutError`, ou `AbortError` selon le navigateur. La coupure réseau : `TypeError`
    // (« Failed to fetch », « NetworkError… », « Load failed »).
    if (deadline?.aborted) throw new Error(TIMEOUT_ERROR_MESSAGE, { cause: error });
    if (error instanceof TypeError) throw new Error(NETWORK_ERROR_MESSAGE, { cause: error });
    throw error;
  }
}

/** Appel JSON de l'API : le corps de la réponse, ou l'erreur de `readJson` (message, statut, code). */
export async function apiRequest<T>(path: string, options?: ApiRequestOptions): Promise<T> {
  return readJson<T>(await apiFetch(path, options));
}

/**
 * Fichier rendu par l'API (PDF, CSV, agenda) : son contenu, le nom annoncé par
 * `content-disposition` (sans chemin) ou `fallbackName`, et les en-têtes de la réponse. Un refus
 * est levé avec son message et son statut, comme pour un appel JSON.
 */
export async function apiDownload(
  path: string,
  options: ApiRequestOptions,
  fallbackName: string,
): Promise<{ blob: Blob; filename: string; headers: Headers }> {
  const response = await send(path, { ...options, file: true });
  if (!response.ok) await readJson<unknown>(response);
  const header = response.headers.get("content-disposition") ?? "";
  const filename = /filename="([^"\\/]+)"/i.exec(header)?.[1]?.trim() || fallbackName;
  return { blob: await response.blob(), filename, headers: response.headers };
}
