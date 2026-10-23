import {
  salesSearchToUrlRecord,
  validateSalesSearch,
  type SalesSearchParams,
  type SalesSearchUrlRecord,
} from "@/lib/search/search-url-state";

/**
 * Alerte demandée par un visiteur sans compte. Sans cette trace, la demande était perdue : la
 * personne créait son compte, confirmait son adresse, revenait sur la page et devait retrouver le
 * bouton. On garde donc les critères (jamais de donnée personnelle : zone, type de bien, prix
 * maximal…) et le choix d'email récapitulatif, et l'alerte est créée à la première connexion
 * (`PendingAlertRunner`).
 *
 * Stockage local du navigateur et non stockage de session : le lien de confirmation de l'email
 * s'ouvre le plus souvent dans un nouvel onglet. La trace expire au bout de 24 h et ne sert
 * qu'une fois.
 */
export const PENDING_ALERT_STORAGE_KEY = "immojudis:alerte-en-attente";
export const PENDING_ALERT_TTL_MS = 24 * 60 * 60 * 1000;

export type PendingAlertOptions = {
  frequency?: "daily" | "weekly";
  /** Case « email récapitulatif » cochée au moment de la demande. */
  emailRecap?: boolean;
  name?: string;
  nameSearch?: SalesSearchParams;
};

export type PendingAlert = {
  search: SalesSearchParams;
  options: PendingAlertOptions;
};

type StoredPendingAlert = {
  savedAt: number;
  search: SalesSearchUrlRecord;
  options: {
    frequency?: "daily" | "weekly";
    emailRecap?: boolean;
    name?: string;
    nameSearch?: SalesSearchUrlRecord;
  };
};

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Garde la demande d'alerte ; ne lève jamais (stockage refusé : la demande est perdue, comme avant). */
export function savePendingAlert(
  search: SalesSearchParams,
  options: PendingAlertOptions = {},
  now = Date.now(),
): void {
  const store = storage();
  if (!store) return;
  const stored: StoredPendingAlert = {
    savedAt: now,
    search: salesSearchToUrlRecord(search),
    options: {
      ...(options.frequency ? { frequency: options.frequency } : {}),
      ...(options.emailRecap ? { emailRecap: true } : {}),
      ...(options.name ? { name: options.name.slice(0, 200) } : {}),
      ...(options.nameSearch ? { nameSearch: salesSearchToUrlRecord(options.nameSearch) } : {}),
    },
  };
  try {
    store.setItem(PENDING_ALERT_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Quota ou navigation privée : rien à faire.
  }
}

export function clearPendingAlert(): void {
  try {
    storage()?.removeItem(PENDING_ALERT_STORAGE_KEY);
  } catch {
    // Rien à faire.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** La demande en attente, ou `null` : absente, expirée ou illisible (elle est alors effacée). */
export function peekPendingAlert(now = Date.now()): PendingAlert | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(PENDING_ALERT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      typeof parsed.savedAt !== "number" ||
      !Number.isFinite(parsed.savedAt) ||
      now - parsed.savedAt > PENDING_ALERT_TTL_MS ||
      parsed.savedAt > now + 60_000 ||
      !isRecord(parsed.search)
    ) {
      clearPendingAlert();
      return null;
    }
    const stored = isRecord(parsed.options) ? parsed.options : {};
    const options: PendingAlertOptions = {
      ...(stored.frequency === "daily" || stored.frequency === "weekly"
        ? { frequency: stored.frequency }
        : {}),
      ...(stored.emailRecap === true ? { emailRecap: true } : {}),
      ...(typeof stored.name === "string" && stored.name
        ? { name: stored.name.slice(0, 200) }
        : {}),
      ...(isRecord(stored.nameSearch)
        ? { nameSearch: validateSalesSearch(stored.nameSearch) }
        : {}),
    };
    return { search: validateSalesSearch(parsed.search), options };
  } catch {
    clearPendingAlert();
    return null;
  }
}

/** Lit la demande et l'efface : elle ne sert qu'une fois, même si la création échoue. */
export function takePendingAlert(now = Date.now()): PendingAlert | null {
  const pending = peekPendingAlert(now);
  clearPendingAlert();
  return pending;
}
