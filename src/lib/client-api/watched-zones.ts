import { apiRequest } from "@/lib/client-api-core";
import type {
  WatchedZoneInput,
  WatchedZoneResponse,
  WatchedZonesResponse,
} from "@/lib/watched-zones";

export function fetchWatchedZones(
  args: {
    includeInactive?: boolean;
  } = {},
): Promise<WatchedZonesResponse> {
  const search = new URLSearchParams();
  if (args.includeInactive) search.set("includeInactive", "true");
  return apiRequest<WatchedZonesResponse>(
    `/api/watched-zones${search.size ? `?${search.toString()}` : ""}`,
  );
}

export function createWatchedZone(args: { data: WatchedZoneInput }): Promise<WatchedZoneResponse> {
  return apiRequest<WatchedZoneResponse>("/api/watched-zones", { method: "POST", body: args.data });
}

export function deleteWatchedZone(args: { zoneId: string }): Promise<{ ok: true }> {
  return apiRequest<{ ok: true }>(`/api/watched-zones/${args.zoneId}`, { method: "DELETE" });
}
