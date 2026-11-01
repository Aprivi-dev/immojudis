import { authHeaders, readJson } from "@/lib/client-api-core";
import type { EmailDesigns } from "@/lib/admin-emails/designs";
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
