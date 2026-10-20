"use client";

import { useMemo, useState } from "react";
import CalendarPlus from "lucide-react/dist/esm/icons/calendar-plus.js";
import { Badge, Button, Card } from "@/components/ui/primitives";
import { FavoriteDossierLine } from "@/components/FavoriteDossierLine";
import { FavoriteSaleChanges } from "@/components/FavoriteSaleChanges";
import { PastFollowedSales } from "@/components/PastFollowedSales";
import { SaleCalendarButton } from "@/components/SaleCalendarButton";
import { SaleDetailLink } from "@/components/SaleDetailLink";
import {
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import { downloadFollowedCalendar } from "@/lib/client-api";
import {
  buildPlanning,
  planningCalendarSaleIds,
  planningDaysLabel,
  PLANNING_CALENDAR_MAX_SALES,
  type PlanningEntry,
} from "@/lib/favorite-planning";
import type { FavoriteSale } from "@/lib/favorites";
import { formatStartingPrice, propertyTypeLabel } from "@/lib/format";
import { saleIsTribunalVenue } from "@/lib/sale-procedure";
import { saleDisplayTitle } from "@/lib/sale-title";
import { seoLongDate } from "@/lib/seo";
import { userMessage } from "@/lib/user-messages";

/**
 * « Mon planning » (`/favoris`) : les ventes suivies par prochaine audience, avec « J-x », le statut
 * et le plafond de « Mon dossier », les changements récents et le bouton agenda ; les ventes passées
 * en bas avec leur instantané. Un seul fichier `.ics` réunit toutes les audiences suivies.
 */
export function FavoritePlanning({
  userId,
  favorites,
  isAnalysis,
  aiReviewBySaleId,
  aiReviewStatus,
}: {
  userId: string | null | undefined;
  favorites: readonly FavoriteSale[];
  isAnalysis: boolean;
  aiReviewBySaleId: Record<string, AiReviewProjectionReadModel[]>;
  aiReviewStatus: AiReviewRequestStatus;
}) {
  const [now] = useState(() => new Date());
  const reviewPending = aiReviewStatus === "loading";
  const planning = useMemo(
    () =>
      buildPlanning({
        favorites,
        now,
        // La relecture de la fiche peut écarter la date : elle n'est alors pas une date sourcée.
        dateBlocked: (saleId) =>
          getAiReviewFieldResult(aiReviewBySaleId[saleId], "sale.sale_date", aiReviewStatus)
            .blocked,
      }),
    [favorites, now, aiReviewBySaleId, aiReviewStatus],
  );
  const calendar = useMemo(() => planningCalendarSaleIds(planning.dated), [planning.dated]);

  return (
    <div id="planning-panel" role="tabpanel" aria-labelledby="planning-tab">
      <section aria-labelledby="planning-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="planning-title" className="font-display text-2xl font-semibold">
              Mon planning
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-ink-soft">
              Vos ventes suivies, de la prochaine audience à la plus lointaine. Les dates viennent
              des annonces : à vérifier auprès de l’avocat poursuivant.
            </p>
          </div>
          {calendar.saleIds.length > 0 ? (
            <FollowedCalendarExport saleIds={calendar.saleIds} truncated={calendar.truncated} />
          ) : null}
        </div>

        {reviewPending ? (
          <p role="status" className="mt-4 text-ink-soft">
            Vérification des dates en cours…
          </p>
        ) : planning.dated.length === 0 ? (
          <Card className="mt-4">
            <p className="font-semibold">Aucune audience à venir dans vos favoris</p>
            <p className="mt-1 text-sm text-ink-soft">
              Les ventes suivies dont l’audience est datée apparaissent ici, par ordre de date.
            </p>
          </Card>
        ) : (
          <ol className="mt-4 grid gap-3">
            {planning.dated.map((entry) => (
              <li key={entry.favorite.saleId}>
                <PlanningRow entry={entry} />
              </li>
            ))}
          </ol>
        )}

        {!reviewPending && planning.undated.length > 0 ? (
          <div className="mt-6">
            <h3 className="font-display text-xl font-semibold">Sans audience datée</h3>
            <p className="mt-1 text-sm text-ink-soft">
              Ces ventes n’ont pas de date d’audience annoncée, ou leur date est reportée ou écartée
              : elles ne figurent ni dans le planning ni dans le fichier d’agenda.
            </p>
            <ul className="mt-3 grid gap-3">
              {planning.undated.map((favorite) => (
                <li key={favorite.saleId}>
                  <Card className="!py-3">
                    <SaleDetailLink
                      saleId={favorite.saleId}
                      returnTo="/favoris"
                      className="font-semibold text-brand-navy underline-offset-4 hover:underline"
                    >
                      {saleDisplayTitle(favorite.sale)}
                    </SaleDetailLink>
                    <FavoriteDossierLine favorite={favorite} />
                  </Card>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <FavoriteSaleChanges
        userId={userId}
        favorites={[...favorites]}
        isAnalysis={isAnalysis}
        aiReviewBySaleId={aiReviewBySaleId}
        aiReviewStatus={aiReviewStatus}
      />
      <PastFollowedSales />
    </div>
  );
}

function PlanningRow({ entry }: { entry: PlanningEntry }) {
  const { favorite } = entry;
  const { sale } = favorite;
  const place = [sale.city, sale.department ? `(${sale.department})` : null]
    .filter(Boolean)
    .join(" ");
  const date = seoLongDate(sale.sale_date);
  return (
    <Card as="article" className="!py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={entry.daysUntil <= 7 ? "warning" : "gold"}>
              {planningDaysLabel(entry.daysUntil)}
            </Badge>
            <span className="text-sm font-semibold text-brand-navy">
              {date}
              {entry.time ? ` à ${entry.time}` : ""}
            </span>
          </p>
          <h3 className="mt-1 font-semibold">
            <SaleDetailLink
              saleId={favorite.saleId}
              returnTo="/favoris"
              className="text-brand-navy underline-offset-4 hover:underline"
            >
              {saleDisplayTitle(sale)}
            </SaleDetailLink>
          </h3>
          <p className="text-sm text-ink-soft">
            {[
              place,
              propertyTypeLabel(sale.property_type),
              formatStartingPrice(sale.starting_price_eur),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <FavoriteDossierLine favorite={favorite} />
        </div>
        {saleIsTribunalVenue(sale) ? <SaleCalendarButton saleId={favorite.saleId} /> : null}
      </div>
    </Card>
  );
}

function FollowedCalendarExport({
  saleIds,
  truncated,
}: {
  saleIds: readonly string[];
  truncated: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  async function download() {
    setPending(true);
    setMessage(null);
    try {
      const file = await downloadFollowedCalendar({ saleIds });
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.filename;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage({
        tone: "info",
        text:
          `${file.exported} audience${file.exported > 1 ? "s" : ""} dans le fichier` +
          (file.skipped > 0
            ? `, ${file.skipped} laissée${file.skipped > 1 ? "s" : ""} de côté (date passée, reportée ou non confirmée).`
            : "."),
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text: userMessage(error, "L’export vers l’agenda est indisponible pour le moment."),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="max-w-sm">
      <Button
        variant="secondary"
        onClick={() => void download()}
        disabled={pending}
        aria-busy={pending}
      >
        <CalendarPlus className="size-4" aria-hidden />
        {pending ? "Préparation…" : "Exporter toutes mes audiences (.ics)"}
      </Button>
      <p className="mt-1 text-xs text-ink-soft">
        Un seul fichier pour votre agenda. Date issue de l’annonce, à vérifier ; le fichier ne se
        met pas à jour si la date change.
        {truncated
          ? ` Seules les ${PLANNING_CALENDAR_MAX_SALES} prochaines audiences sont exportées.`
          : ""}
      </p>
      {message ? (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={`mt-1 text-xs ${message.tone === "error" ? "text-red-700" : "text-ink-soft"}`}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
