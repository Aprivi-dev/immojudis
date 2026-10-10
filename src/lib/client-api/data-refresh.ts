import { authHeaders, readJson } from "@/lib/client-api-core";
import type {
  DataRefreshListResponse,
  DataRefreshRequestInput,
  DataRefreshRequestResponse,
} from "@/lib/data-refresh";

export async function requestDataRefresh(
  input: DataRefreshRequestInput,
): Promise<DataRefreshRequestResponse> {
  const response = await fetch("/api/data-refresh", {
    method: "POST",
    headers: {
      ...(await authHeaders()),
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });

  return readJson<DataRefreshRequestResponse>(response);
}

export async function fetchDataRefreshRequests(
  args: {
    saleId?: string;
    status?: string;
  } = {},
): Promise<DataRefreshListResponse> {
  const params = new URLSearchParams();
  if (args.saleId) params.set("saleId", args.saleId);
  if (args.status) params.set("status", args.status);
  const response = await fetch(`/api/data-refresh${params.size ? `?${params.toString()}` : ""}`, {
    headers: await authHeaders(),
  });

  return readJson<DataRefreshListResponse>(response);
}
