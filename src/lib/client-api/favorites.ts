import { apiDownload, apiRequest } from "@/lib/client-api-core";
import type { FavoriteDossierInput, FavoriteDossierResponse } from "@/lib/favorite-dossier-shared";
import type {
  FollowedSaleSnapshotDeleteResponse,
  FollowedSaleSnapshotResponse,
  FollowedSaleSnapshotsResponse,
  FollowedSaleSnapshotUpdate,
} from "@/lib/followed-sale-snapshots-shared";
import type {
  FavoriteSaleDeleteResponse,
  FavoriteSaleInput,
  FavoriteSaleMutationResponse,
  FavoriteSalesResponse,
} from "@/lib/favorites";

export function fetchFavoriteSales(): Promise<FavoriteSalesResponse> {
  return apiRequest<FavoriteSalesResponse>("/api/favorites");
}

export function addFavoriteSale(args: {
  data: FavoriteSaleInput;
}): Promise<FavoriteSaleMutationResponse> {
  return apiRequest<FavoriteSaleMutationResponse>("/api/favorites", {
    method: "POST",
    body: args.data,
  });
}

export function removeFavoriteSale(args: { saleId: string }): Promise<FavoriteSaleDeleteResponse> {
  const search = new URLSearchParams({ saleId: args.saleId });
  return apiRequest<FavoriteSaleDeleteResponse>(`/api/favorites?${search.toString()}`, {
    method: "DELETE",
  });
}

/** « Mon dossier » gratuit (point 68) : statut et enchère plafond enregistrés sur une vente suivie. */
export function fetchFavoriteDossier(saleId: string): Promise<FavoriteDossierResponse> {
  const search = new URLSearchParams({ saleId });
  return apiRequest<FavoriteDossierResponse>(`/api/favorites/dossier?${search.toString()}`);
}

export function saveFavoriteDossier(args: {
  data: FavoriteDossierInput;
}): Promise<FavoriteDossierResponse> {
  return apiRequest<FavoriteDossierResponse>("/api/favorites/dossier", {
    method: "PUT",
    body: args.data,
  });
}

/** Après l'audience (point 70) : instantanés des ventes suivies, gardés 6 mois au plus. */
export function fetchFollowedSaleSnapshots(): Promise<FollowedSaleSnapshotsResponse> {
  return apiRequest<FollowedSaleSnapshotsResponse>("/api/favorites/snapshots");
}

export function deleteFollowedSaleSnapshot(args: {
  id: string;
}): Promise<FollowedSaleSnapshotDeleteResponse> {
  const search = new URLSearchParams({ id: args.id });
  return apiRequest<FollowedSaleSnapshotDeleteResponse>(
    `/api/favorites/snapshots?${search.toString()}`,
    { method: "DELETE" },
  );
}

/** Bilan après adjudication : le statut et le prix final noté sur un instantané. */
export function updateFollowedSaleSnapshot(args: {
  data: FollowedSaleSnapshotUpdate;
}): Promise<FollowedSaleSnapshotResponse> {
  return apiRequest<FollowedSaleSnapshotResponse>("/api/favorites/snapshots", {
    method: "PUT",
    body: args.data,
  });
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
  const { blob, filename, headers } = await apiDownload(
    "/api/favorites/calendar",
    { method: "POST", body: { saleIds: args.saleIds } },
    "immojudis-audiences.ics",
  );
  return {
    blob,
    filename,
    exported: Number(headers.get("x-exported-count")) || 0,
    skipped: Number(headers.get("x-skipped-count")) || 0,
  };
}

/** L'échéancier indicatif (surenchère, paiement du prix) d'une vente passée remportée, en `.ics`. */
export async function downloadSnapshotDeadlines(args: {
  snapshotId: string;
}): Promise<{ blob: Blob; filename: string }> {
  const { blob, filename } = await apiDownload(
    "/api/favorites/calendar",
    { method: "POST", body: { deadlinesSnapshotId: args.snapshotId } },
    "immojudis-echeancier.ics",
  );
  return { blob, filename };
}
