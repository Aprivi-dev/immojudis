import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { recordAccountProductEvent } from "@/lib/account-product-events.server";
import { PublicApiError } from "@/lib/api-errors";
import { apiRoute } from "@/lib/api-route";
import {
  exportFollowedCalendar,
  exportSnapshotDeadlines,
  favoriteCalendarInputSchema,
} from "@/lib/favorite-calendar";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import type { SaleCalendarFile } from "@/lib/sale-calendar";
import { siteOrigin } from "@/lib/site-url";

/**
 * « Mon planning » : le fichier `.ics` de toutes les audiences suivies, en un téléchargement.
 *
 * Authentifié (jeton du compte), limité par compte (30 par minute) et plafonné à 50 ventes par
 * fichier. Le corps donne les ventes à exporter (le navigateur envoie les prochaines audiences de
 * ses favoris) ; le serveur ne garde que celles que le compte suit vraiment, puis applique à chacune
 * la règle de l'export d'une seule audience (`get_public_sale_calendar_event`, voir
 * `exportFollowedCalendar`). Jamais mis en cache ; aucune adresse de bien dans le fichier.
 *
 * Visites : le fichier reprend aussi les créneaux de visite datés des annonces (voir
 * `visit-slots.ts`), à venir seulement, sans lieu ni adresse. Échéancier : le corps
 * `{ deadlinesSnapshotId }` rend à la place l'échéancier indicatif d'une vente passée marquée
 * « Remporté » (`exportSnapshotDeadlines`).
 *
 * Mesure (point 65) : un événement `calendar_exported` par vente écrite dans le fichier, comme
 * l'export d'une seule audience ; la base en garde un par compte, vente et jour, et au plus 50 par
 * compte et par jour.
 */
export const POST = apiRoute(
  {
    scope: "api.favorites.calendar",
    fallbackMessage: "Export vers l’agenda indisponible.",
    headers: { "x-robots-tag": "noindex, nofollow" },
  },
  async (request, { api }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "favorites-calendar",
      ...RATE_LIMIT_POLICIES.compute,
      context: api,
    });
    const input = favoriteCalendarInputSchema.parse(await request.json());

    // Jamais déduite de la requête : le fichier porte des adresses absolues vers les fiches.
    const origin = siteOrigin();
    if ("deadlinesSnapshotId" in input) {
      // Échéancier indicatif d'une vente passée remportée : deux dates à confirmer avec l'avocat. Ni
      // mesure « calendar_exported » (réservée aux audiences), ni prix, ni adresse dans le fichier.
      const file = await exportSnapshotDeadlines({
        auth,
        snapshotId: input.deadlinesSnapshotId,
        origin,
      });
      return calendarFileResponse(file, { exported: "2", skipped: "0" });
    }
    const { file, followed, skipped } = await exportFollowedCalendar({
      auth,
      saleIds: input.saleIds,
      origin,
    });
    if (!file) {
      throw new PublicApiError(
        followed === 0
          ? "Aucune de ces ventes n’est dans vos favoris."
          : "Nous n’ajoutons aucune de ces audiences à votre agenda : leur date est passée, reportée ou n’est pas confirmée (information contradictoire ou source unique). Vérifiez-les auprès de l’avocat poursuivant ou du greffe.",
        409,
      );
    }

    await Promise.all(
      file.exportedIds.map((saleId) =>
        recordAccountProductEvent(auth.userId, { type: "calendar_exported", saleId }),
      ),
    );

    return calendarFileResponse(file, {
      exported: String(file.exportedIds.length),
      skipped: String(skipped),
    });
  },
);

function calendarFileResponse(
  file: SaleCalendarFile,
  counts: { exported: string; skipped: string },
): Response {
  return new NextResponse(file.body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${file.filename}"`,
      "x-exported-count": counts.exported,
      "x-skipped-count": counts.skipped,
    },
  });
}
