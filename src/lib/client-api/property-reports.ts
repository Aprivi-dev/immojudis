import { authHeaders, readJson } from "@/lib/client-api-core";
import type {
  PropertyReportListResponse,
  PropertyReportRequestInput,
  PropertyReportSaveResponse,
  PropertyReportShareResponse,
  PropertyReportUpdateInput,
  PlanEntitlements,
} from "@/lib/property-reports";
import type { PlanUsageSummary } from "@/lib/usage";

export async function fetchPropertyReports(
  args: {
    saleId?: string;
  } = {},
): Promise<PropertyReportListResponse> {
  const search = new URLSearchParams();
  if (args.saleId) search.set("saleId", args.saleId);
  const url = `/api/property-reports${search.size ? `?${search.toString()}` : ""}`;

  const response = await fetch(url, {
    headers: await authHeaders(),
  });

  return readJson<PropertyReportListResponse>(response);
}

export async function savePropertyReport(args: {
  data: PropertyReportRequestInput;
}): Promise<PropertyReportSaveResponse> {
  const response = await fetch("/api/property-reports", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<PropertyReportSaveResponse>(response);
}

export async function updatePropertyReport(args: {
  reportId: string;
  data: PropertyReportUpdateInput;
}): Promise<PropertyReportSaveResponse> {
  const response = await fetch(`/api/property-reports/${args.reportId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<PropertyReportSaveResponse>(response);
}

export async function exportPropertyReportPdf(args: {
  reportId: string;
}): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(`/api/property-reports/${args.reportId}/export`, {
    method: "POST",
    headers: await authHeaders(),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Erreur HTTP ${response.status}`);
  }

  const filename =
    response.headers
      .get("content-disposition")
      ?.match(/filename="([^"]+)"/)?.[1]
      ?.trim() || "rapport-immojudis.pdf";

  return {
    blob: await response.blob(),
    filename,
  };
}

export async function enablePropertyReportShare(args: {
  reportId: string;
  expiresAt?: string | null;
}): Promise<PropertyReportShareResponse> {
  const response = await fetch(`/api/property-reports/${args.reportId}/share`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ expiresAt: args.expiresAt ?? null }),
  });

  return readJson<PropertyReportShareResponse>(response);
}

export async function disablePropertyReportShare(args: {
  reportId: string;
}): Promise<PropertyReportShareResponse> {
  const response = await fetch(`/api/property-reports/${args.reportId}/share`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  return readJson<PropertyReportShareResponse>(response);
}

export async function fetchFeatureEntitlements(): Promise<{
  plan: PlanEntitlements;
  usage: PlanUsageSummary;
}> {
  const response = await fetch("/api/feature-entitlements", {
    headers: await authHeaders(),
    cache: "no-store",
  });

  return readJson<{ plan: PlanEntitlements; usage: PlanUsageSummary }>(response);
}
