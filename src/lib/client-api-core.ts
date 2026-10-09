import { supabase } from "@/integrations/supabase/client";

export async function authHeaders(): Promise<HeadersInit> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error("Connexion requise.");
  }

  return {
    Authorization: `Bearer ${session.access_token}`,
  };
}

export async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;

  if (!response.ok) {
    // Le statut accompagne l'erreur pour que userMessage() choisisse la bonne phrase (429, 401, 5xx).
    throw Object.assign(new Error(payload?.error ?? `Erreur HTTP ${response.status}`), {
      status: response.status,
    });
  }

  return payload as T;
}
