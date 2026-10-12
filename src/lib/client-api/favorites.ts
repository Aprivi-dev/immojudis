import { authHeaders, readJson } from "@/lib/client-api-core";
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
