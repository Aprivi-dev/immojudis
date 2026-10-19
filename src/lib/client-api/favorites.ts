import { authHeaders, readJson } from "@/lib/client-api-core";
import type { FavoriteDossierInput, FavoriteDossierResponse } from "@/lib/favorite-dossier-shared";
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
