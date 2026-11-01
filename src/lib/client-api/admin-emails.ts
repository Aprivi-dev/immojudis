import { authHeaders, readJson } from "@/lib/client-api-core";
import type { EmailDesigns } from "@/lib/admin-emails/designs";
import type { HistoryList, HistoryMessage } from "@/lib/admin-emails/history";
import type { EmailListView } from "@/lib/admin-emails/views";

async function getAdminEmails<T>(path: string): Promise<T> {
  const response = await fetch(`/api/admin/emails/${path}`, {
    signal: AbortSignal.timeout(30_000),
    headers: await authHeaders(),
    cache: "no-store",
  });
  return readJson<T>(response);
}

export const fetchAdminEmailDesigns = (dark: boolean) =>
  getAdminEmails<EmailDesigns>(`designs${dark ? "?theme=dark" : ""}`);

export const fetchAdminEmailAddresses = (refresh = false) =>
  getAdminEmails<EmailListView>(`addresses${refresh ? "?refresh=1" : ""}`);

export const fetchAdminEmailTemplates = () => getAdminEmails<EmailListView>("templates");

export type AdminEmailHistoryQuery = {
  box: "sent" | "received";
  address: string;
  cursor: string;
  refresh: boolean;
};

/**
 * Avec une adresse : POST, l'adresse dans le corps. Elle ne figure jamais dans l'URL, qui finit dans les
 * journaux de requêtes et l'historique du navigateur. Sans adresse : GET (pagination et actualisation).
 */
export async function fetchAdminEmailHistory(query: AdminEmailHistoryQuery): Promise<HistoryList> {
  if (query.address) {
    const response = await fetch("/api/admin/emails/history", {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      cache: "no-store",
      body: JSON.stringify(query),
    });
    return readJson<HistoryList>(response);
  }
  const params = new URLSearchParams({ box: query.box, cursor: query.cursor });
  if (query.refresh) params.set("refresh", "1");
  return getAdminEmails<HistoryList>(`history?${params}`);
}

export const fetchAdminEmailMessage = (id: string) =>
  getAdminEmails<HistoryMessage>(`history/${encodeURIComponent(id)}`);
