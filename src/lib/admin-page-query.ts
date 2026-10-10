import { z } from "zod";
import {
  ADMIN_PAGE_MAX_LIMIT,
  ADMIN_PAGE_MAX_OFFSET,
  ADMIN_PAGE_SIZE,
} from "@/lib/admin-pagination";

/** Champs `offset` / `limit` communs aux listes admin, à étendre avec les filtres de la route. */
export const adminPageQueryShape = {
  offset: z.coerce.number().int().min(0).max(ADMIN_PAGE_MAX_OFFSET).default(0),
  limit: z.coerce.number().int().min(1).max(ADMIN_PAGE_MAX_LIMIT).default(ADMIN_PAGE_SIZE),
};

export const adminPageQuerySchema = z.object(adminPageQueryShape);
export type AdminPageQuery = z.output<typeof adminPageQuerySchema>;
