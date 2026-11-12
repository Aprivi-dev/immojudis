import { z } from "zod";
import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  listSaleChangeEvents,
  monitorUserSaleChanges,
  saleChangeEventActionSchema,
  updateSaleChangeEventState,
} from "@/lib/sale-change-monitor";

export const GET = apiRoute(
  { scope: "sale-change-events", fallbackMessage: "Changements indisponibles" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    return listSaleChangeEvents({
      auth,
      limit: Number(url.searchParams.get("limit") ?? 80),
      includeDismissed: url.searchParams.get("includeDismissed") === "true",
      saleId: z
        .string()
        .guid()
        .optional()
        .parse(url.searchParams.get("saleId") ?? undefined),
    });
  },
);

export const POST = apiRoute(
  { scope: "sale-change-events", fallbackMessage: "Monitoring des changements impossible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return monitorUserSaleChanges({ auth });
  },
);

export const PATCH = apiRoute(
  { scope: "sale-change-events", fallbackMessage: "Changement impossible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = saleChangeEventActionSchema.parse(await request.json());
    return updateSaleChangeEventState({
      auth,
      eventId: input.eventId,
      action: input.action,
    });
  },
);
