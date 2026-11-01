import "server-only";

/**
 * Lecture de la configuration Resend (domaines, DNS, webhooks) pour l'onglet « Adresses ». Lecture
 * seule : trois requêtes GET, aucun envoi d'email. La réponse du fournisseur est recopiée champ par
 * champ dans une liste blanche (jamais renvoyée telle quelle : un webhook porte un secret de
 * signature), et toute erreur est ramenée à une catégorie sans le message d'origine.
 */

const RESEND_API = "https://api.resend.com";
const REQUEST_TIMEOUT_MS = 8_000;
/** Un domaine par appel : au plus ce nombre de détails lus, pour rester sous la limite de débit. */
const MAX_DOMAIN_DETAILS = 10;

export type ResendFailure =
  | "not_configured"
  | "missing_permission"
  | "invalid_key"
  | "rate_limited"
  | "unavailable";

export type ResendDnsRecord = {
  /** `SPF`, `DKIM`, `Receiving`, `Tracking`… */
  kind: string;
  type: string;
  name: string;
  status: string;
};

export type ResendDomain = {
  name: string;
  status: string;
  region: string | null;
  sending: boolean;
  receiving: boolean;
  records: ResendDnsRecord[];
};

export type ResendWebhook = {
  /** Origine et chemin seulement : ni identifiants, ni paramètres d'adresse. */
  endpoint: string;
  enabled: boolean;
  /** `null` : le fournisseur n'a pas limité les évènements. */
  events: string[] | null;
};

export type ResendResult<T> = { ok: true; data: T } | { ok: false; failure: ResendFailure };

type FetchLike = typeof fetch;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

async function resendGet(
  path: string,
  apiKey: string | null,
  fetchImpl: FetchLike,
): Promise<ResendResult<unknown>> {
  if (!apiKey) return { ok: false, failure: "not_configured" };
  try {
    const response = await fetchImpl(`${RESEND_API}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.ok) return { ok: true, data: await response.json() };
    // Le corps de l'erreur n'est lu que pour son nom de code, jamais renvoyé ni journalisé.
    const body: unknown = await response.json().catch(() => null);
    const code = isRecord(body) ? text(body.name) : "";
    if (response.status === 429) return { ok: false, failure: "rate_limited" };
    if (code === "restricted_api_key" || response.status === 403) {
      return { ok: false, failure: "missing_permission" };
    }
    if (response.status === 401) return { ok: false, failure: "invalid_key" };
    return { ok: false, failure: "unavailable" };
  } catch {
    return { ok: false, failure: "unavailable" };
  }
}

function listOf(payload: unknown): Record<string, unknown>[] {
  return isRecord(payload) && Array.isArray(payload.data) ? payload.data.filter(isRecord) : [];
}

function mapRecord(raw: Record<string, unknown>): ResendDnsRecord {
  return {
    kind: text(raw.record),
    type: text(raw.type),
    name: text(raw.name),
    status: text(raw.status),
  };
}

/** Domaines d'envoi et de réception avec l'état de chaque enregistrement DNS (SPF, DKIM, MX…). */
export async function fetchResendDomains(
  apiKey: string | null,
  fetchImpl: FetchLike = fetch,
): Promise<ResendResult<ResendDomain[]>> {
  const list = await resendGet("/domains", apiKey, fetchImpl);
  if (!list.ok) return list;
  const domains: ResendDomain[] = [];
  for (const summary of listOf(list.data).slice(0, MAX_DOMAIN_DETAILS)) {
    const id = text(summary.id);
    // Un à un : la limite de débit de Resend est basse et les domaines sont peu nombreux.
    const detail = id
      ? await resendGet(`/domains/${encodeURIComponent(id)}`, apiKey, fetchImpl)
      : null;
    if (detail && !detail.ok) return detail;
    const source = detail && isRecord(detail.data) ? detail.data : summary;
    const capabilities = isRecord(source.capabilities) ? source.capabilities : {};
    domains.push({
      name: text(source.name).toLowerCase(),
      status: text(source.status),
      region: text(source.region) || null,
      sending: capabilities.sending === "enabled",
      receiving: capabilities.receiving === "enabled",
      records: Array.isArray(source.records) ? source.records.filter(isRecord).map(mapRecord) : [],
    });
  }
  return { ok: true, data: domains };
}

function sanitizedEndpoint(value: unknown): string {
  try {
    const url = new URL(text(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

/** Webhooks déclarés chez Resend. Le secret de signature n'est jamais recopié. */
export async function fetchResendWebhooks(
  apiKey: string | null,
  fetchImpl: FetchLike = fetch,
): Promise<ResendResult<ResendWebhook[]>> {
  const list = await resendGet("/webhooks", apiKey, fetchImpl);
  if (!list.ok) return list;
  return {
    ok: true,
    data: listOf(list.data).map((raw) => ({
      endpoint: sanitizedEndpoint(raw.endpoint),
      enabled: raw.status === "enabled",
      events: Array.isArray(raw.events)
        ? raw.events.filter((event): event is string => typeof event === "string")
        : null,
    })),
  };
}
