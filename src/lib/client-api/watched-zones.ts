import { authHeaders, readJson } from "@/lib/client-api-core";
import type {
  WatchedZoneInput,
  WatchedZoneResponse,
  WatchedZonesResponse,
  WatchedZoneUpdateInput,
} from "@/lib/watched-zones";

export async function fetchWatchedZones(
  args: {
    includeInactive?: boolean;
  } = {},
): Promise<WatchedZonesResponse> {
  const search = new URLSearchParams();
  if (args.includeInactive) search.set("includeInactive", "true");
  const response = await fetch(`/api/watched-zones${search.size ? `?${search.toString()}` : ""}`, {
    headers: await authHeaders(),
  });

  return readJson<WatchedZonesResponse>(response);
}

export async function createWatchedZone(args: {
  data: WatchedZoneInput;
}): Promise<WatchedZoneResponse> {
  const response = await fetch("/api/watched-zones", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<WatchedZoneResponse>(response);
}

export async function updateWatchedZone(args: {
  zoneId: string;
  data: WatchedZoneUpdateInput;
}): Promise<WatchedZoneResponse> {
  const response = await fetch(`/api/watched-zones/${args.zoneId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<WatchedZoneResponse>(response);
}

export async function deleteWatchedZone(args: { zoneId: string }): Promise<{ ok: true }> {
  const response = await fetch(`/api/watched-zones/${args.zoneId}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  return readJson<{ ok: true }>(response);
}
