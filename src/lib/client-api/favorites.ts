import { authHeaders, readJson } from "@/lib/client-api-core";
import type { FavoriteDossierInput, FavoriteDossierResponse } from "@/lib/favorite-dossier-shared";
import type {
  FollowedSaleSnapshotDeleteResponse,
  FollowedSaleSnapshotsResponse,
} from "@/lib/followed-sale-snapshots-shared";
import type {
  FavoriteSaleDeleteResponse,
  FavoriteSaleInput,
  FavoriteSaleMutationResponse,
  FavoriteSalesResponse,
} from "@/lib/favorites";

export async function fetchFavoriteSales(): Promise<FavoriteSalesResponse> {
  const response = await fetch("/api/favorites", {
    headers: await authHeaders(),
  });

  return readJson<FavoriteSalesResponse>(response);
}

export async function addFavoriteSale(args: {
  data: FavoriteSaleInput;
}): Promise<FavoriteSaleMutationResponse> {
  const response = await fetch("/api/favorites", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<FavoriteSaleMutationResponse>(response);
}

export async function removeFavoriteSale(args: {
  saleId: string;
}): Promise<FavoriteSaleDeleteResponse> {
  const search = new URLSearchParams({ saleId: args.saleId });
  const response = await fetch(`/api/favorites?${search.toString()}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  return readJson<FavoriteSaleDeleteResponse>(response);
}

/** « Mon dossier » gratuit (point 68) : statut et enchère plafond enregistrés sur une vente suivie. */
export async function fetchFavoriteDossier(saleId: string): Promise<FavoriteDossierResponse> {
  const search = new URLSearchParams({ saleId });
  const response = await fetch(`/api/favorites/dossier?${search.toString()}`, {
    headers: await authHeaders(),
  });

  return readJson<FavoriteDossierResponse>(response);
}

export async function saveFavoriteDossier(args: {
  data: FavoriteDossierInput;
}): Promise<FavoriteDossierResponse> {
  const response = await fetch("/api/favorites/dossier", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<FavoriteDossierResponse>(response);
}

/** Après l'audience (point 70) : instantanés des ventes suivies, gardés 6 mois au plus. */
export async function fetchFollowedSaleSnapshots(): Promise<FollowedSaleSnapshotsResponse> {
  const response = await fetch("/api/favorites/snapshots", {
    headers: await authHeaders(),
  });

  return readJson<FollowedSaleSnapshotsResponse>(response);
}

export async function deleteFollowedSaleSnapshot(args: {
  id: string;
}): Promise<FollowedSaleSnapshotDeleteResponse> {
  const search = new URLSearchParams({ id: args.id });
  const response = await fetch(`/api/favorites/snapshots?${search.toString()}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });

  return readJson<FollowedSaleSnapshotDeleteResponse>(response);
}

type FollowedCalendarDownload = {
  blob: Blob;
  filename: string;
  /** Audiences écrites dans le fichier. */
  exported: number;
  /** Ventes suivies laissées de côté (date non exportable : passée, reportée, non confirmée). */
  skipped: number;
};

/**
 * « Mon planning » : le fichier `.ics` de toutes les audiences suivies (au plus 50). Le serveur ne
 * garde que les ventes que le compte suit et dont la date est exportable ; un refus (409) arrive en
 * erreur avec son message.
 */
export async function downloadFollowedCalendar(args: {
  saleIds: readonly string[];
}): Promise<FollowedCalendarDownload> {
  const response = await fetch("/api/favorites/calendar", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify({ saleIds: args.saleIds }),
  });
  if (!response.ok) {
    await readJson<unknown>(response);
  }
  const header = response.headers.get("content-disposition") ?? "";
  const filename = /filename="([^"\\/]+\.ics)"/i.exec(header)?.[1] ?? "immojudis-audiences.ics";
  return {
    blob: await response.blob(),
    filename,
    exported: Number(response.headers.get("x-exported-count")) || 0,
    skipped: Number(response.headers.get("x-skipped-count")) || 0,
  };
}
