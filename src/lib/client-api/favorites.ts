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
