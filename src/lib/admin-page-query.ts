import { z } from "zod";
import {
  ADMIN_PAGE_MAX_LIMIT,
  ADMIN_PAGE_MAX_OFFSET,
  ADMIN_PAGE_SIZE,
} from "@/lib/admin-pagination";

/** Champ `limit` d'une liste admin ; `defaultLimit` : taille de page sans paramètre. */
export function adminPageLimit(defaultLimit: number = ADMIN_PAGE_SIZE) {
  return z.coerce.number().int().min(1).max(ADMIN_PAGE_MAX_LIMIT).default(defaultLimit);
}

/** Champs `offset` / `limit` communs aux listes admin, à étendre avec les filtres de la route. */
export const adminPageQueryShape = {
  offset: z.coerce.number().int().min(0).max(ADMIN_PAGE_MAX_OFFSET).default(0),
  limit: adminPageLimit(),
};

export const adminPageQuerySchema = z.object(adminPageQueryShape);

export type AdminPageQuery = z.output<typeof adminPageQuerySchema>;
