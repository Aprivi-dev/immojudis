import type { AuctionSale } from "@/lib/types";

/**
 * Sources retirées du catalogue (interrupteur `auction_source_state.catalogue_withdrawn`, posé et levé
 * par `public.set_catalogue_source_withdrawal`, voir `docs/roadmaps/conditions-de-lancement-2026-10-10.md`).
 *
 * Vench est retirée depuis le 29/10/2026 (migration 20261109153217_withdraw_vench_source.sql), Petites Affiches
 * depuis le 30/10/2026 (20261110093117_withdraw_petites_affiches_source.sql).
 * La base masque les ventes dont TOUTES les sources sont retirées. Ce module couvre le reste : une vente
 * fusionnée avec une autre source reste visible, mais ses liens, photos et pièces hébergés par une source
 * retirée ne s'affichent pas. L'état par défaut est « aucune source retirée » : si la base ne répond pas ou
 * si la migration n'est pas appliquée (fonction absente), rien n'est masqué.
 */
export const DEFAULT_WITHDRAWN_SOURCES: readonly string[] = [];

/** Hôtes propres à une source (images, pièces, fiches). */
const SOURCE_HOSTS: Record<string, readonly string[]> = {
  licitor: ["licitor.com"],
  vench: ["vench.fr"],
  petites_affiches: ["petitesaffiches.fr"],
};

const CACHE_MS = 60_000;

let withdrawn: ReadonlySet<string> = new Set(DEFAULT_WITHDRAWN_SOURCES);
let loadedAt = 0;
let inFlight: Promise<readonly string[]> | null = null;

export function getWithdrawnSources(): ReadonlySet<string> {
  return withdrawn;
}

/** Remplace la liste ; sans argument, revient à l'état par défaut. Retourne `true` si elle a changé. */
export function setWithdrawnSources(names?: readonly string[] | null): boolean {
  const next = new Set(
    (names ?? DEFAULT_WITHDRAWN_SOURCES).map((name) => name.trim().toLowerCase()).filter(Boolean),
  );
  const changed = next.size !== withdrawn.size || [...next].some((name) => !withdrawn.has(name));
  withdrawn = next;
  return changed;
}

export function resetWithdrawnSources(): void {
  setWithdrawnSources(null);
  loadedAt = 0;
  inFlight = null;
}

export type WithdrawnSourcesClient = {
  rpc: (fn: "get_withdrawn_catalogue_sources") => PromiseLike<{ data: unknown; error: unknown }>;
};

/**
 * Lit l'interrupteur en base (au plus une fois par minute). En cas d'erreur (réseau, fonction absente
 * parce que la migration n'est pas appliquée), l'état par défaut s'applique : aucune source retirée.
 */
export function loadWithdrawnSources(
  client: WithdrawnSourcesClient,
  now: number = Date.now(),
): Promise<readonly string[]> {
  if (inFlight) return inFlight;
  if (loadedAt && now - loadedAt < CACHE_MS) return Promise.resolve([...withdrawn]);
  inFlight = Promise.resolve(client.rpc("get_withdrawn_catalogue_sources"))
    .then(({ data, error }) => {
      if (error || !Array.isArray(data)) {
        setWithdrawnSources(null);
      } else {
        setWithdrawnSources(data.filter((name): name is string => typeof name === "string"));
        loadedAt = now;
      }
      return [...withdrawn];
    })
    .catch(() => {
      setWithdrawnSources(null);
      return [...withdrawn];
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

const SESSION_KEY = "immojudis:withdrawn-sources";
// Courte à dessein : le retrait d'une source pour raison juridique doit se propager vite.
const SESSION_MS = 5 * 60_000;

type SessionStorageLike = Pick<Storage, "getItem" | "setItem">;

function browserSessionStorage(): SessionStorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function readSessionWithdrawnSources(storage: SessionStorageLike, now: number): string[] | null {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(SESSION_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const { at, names } = parsed as { at?: unknown; names?: unknown };
    if (typeof at !== "number" || now - at < 0 || now - at >= SESSION_MS) return null;
    if (!Array.isArray(names)) return null;
    return names.filter((name): name is string => typeof name === "string");
  } catch {
    return null;
  }
}

/**
 * Comme `loadWithdrawnSources`, mais l'interrupteur n'est lu qu'une fois par session de navigation
 * (5 minutes, `sessionStorage`) au lieu de l'être à chaque chargement de page. Seule une lecture
 * réussie est mémorisée : une erreur laisse l'état par défaut et sera retentée à la page suivante.
 * Si `sessionStorage` est inaccessible, on lit comme avant.
 */
export async function loadWithdrawnSourcesOncePerSession(
  client: WithdrawnSourcesClient,
  {
    storage = browserSessionStorage(),
    now = Date.now(),
  }: { storage?: SessionStorageLike | null; now?: number } = {},
): Promise<readonly string[]> {
  const remembered = storage ? readSessionWithdrawnSources(storage, now) : null;
  if (remembered) {
    setWithdrawnSources(remembered);
    return [...withdrawn];
  }
  const names = await loadWithdrawnSources(client, now);
  if (storage && loadedAt > 0 && now - loadedAt < CACHE_MS) {
    try {
      storage.setItem(SESSION_KEY, JSON.stringify({ at: now, names }));
    } catch {
      // Stockage plein ou refusé : la prochaine page relira.
    }
  }
  return names;
}

/** Source retirée dont `url` est un hôte propre, sinon `null`. */
export function withdrawnSourceOfUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  let host: string;
  try {
    host = new URL(url.trim()).hostname.replace(/\.$/, "").toLowerCase();
  } catch {
    return null;
  }
  for (const source of withdrawn) {
    const hosts = SOURCE_HOSTS[source] ?? [];
    if (hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return source;
  }
  return null;
}

export function isWithdrawnSourceUrl(url: unknown): boolean {
  return withdrawnSourceOfUrl(url) !== null;
}

export function isWithdrawnSourceName(name: unknown): boolean {
  return typeof name === "string" && withdrawn.has(name.trim().toLowerCase());
}

function urlOf(entry: unknown): unknown {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && "url" in entry) return (entry as { url: unknown }).url;
  return null;
}

function keepAllowed<T>(entries: T[]): T[] {
  return entries.filter((entry) => !isWithdrawnSourceUrl(urlOf(entry)));
}

/**
 * Retire d'une vente le contenu propre à une source retirée : URL de la fiche, liens, photos, pièces.
 * Les textes (titre, description) ne portent pas leur provenance champ par champ et ne sont pas filtrés.
 */
export function stripWithdrawnSourceContent<T extends Partial<AuctionSale>>(sale: T): T {
  if (withdrawn.size === 0) return sale;
  const next: Partial<AuctionSale> = { ...sale };

  let alternatives: string[] = [];
  if (Array.isArray(sale.source_urls)) {
    alternatives = keepAllowed(sale.source_urls as unknown[]).filter(
      (url): url is string => typeof url === "string",
    );
    next.source_urls = alternatives;
  } else if (sale.source_urls && typeof sale.source_urls === "object") {
    const kept = Object.entries(sale.source_urls as Record<string, unknown>).filter(
      ([label, url]) => !isWithdrawnSourceName(label) && !isWithdrawnSourceUrl(url),
    );
    next.source_urls = Object.fromEntries(kept);
    alternatives = kept
      .map(([, url]) => url)
      .filter((url): url is string => typeof url === "string");
  }

  if (isWithdrawnSourceUrl(sale.source_url) || isWithdrawnSourceName(sale.source_name)) {
    // L'identité de la vente reste son `id` ; on n'affiche ni l'URL ni le nom de la source retirée.
    next.source_url = alternatives[0] ?? null;
    next.source_name = null;
  }

  if (Array.isArray(sale.media)) next.media = keepAllowed(sale.media);
  if (Array.isArray(sale.documents)) next.documents = keepAllowed(sale.documents as unknown[]);
  if (Array.isArray(sale.documents_rich)) next.documents_rich = keepAllowed(sale.documents_rich);
  return next as T;
}
