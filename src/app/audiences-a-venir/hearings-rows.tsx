import Link from "next/link";
import { SaleDetailLink } from "@/components/SaleDetailLink";
import { formatStartingPrice, propertyTypeLabel } from "@/lib/format";
import {
  HEARINGS_WEEK_DAYS,
  HEARINGS_WINDOW_DAYS,
  type HearingDay,
  type HearingWindows,
} from "@/lib/upcoming-hearings";
import type { ListedDay, ListedWindows } from "./hearings-list";

/** Le jour en toutes lettres ; « (aujourd’hui) » et « (demain) » s'ajoutent dans le navigateur (`RelativeDay`). */
function dayLabel(dayKey: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dayKey}T12:00:00Z`));
}

function listDay(day: HearingDay, tribunalPaths: Readonly<Record<string, string>>): ListedDay {
  return {
    dayKey: day.dayKey,
    label: dayLabel(day.dayKey),
    groups: day.tribunals.map((group) => {
      const tribunalPath = group.tribunalCode ? tribunalPaths[group.tribunalCode] : null;
      return {
        key: group.key,
        heading: (
          <h4 className="font-semibold">
            {tribunalPath ? (
              <Link href={tribunalPath} className="text-gold-text underline">
                {group.label}
              </Link>
            ) : (
              group.label
            )}
          </h4>
        ),
        hearings: group.hearings.map((hearing) => ({
          id: hearing.id,
          department: hearing.department?.trim() || null,
          row: (
            <SaleDetailLink
              saleId={hearing.id.toLowerCase()}
              returnTo="/audiences-a-venir"
              className="grid gap-1 sm:grid-cols-[1fr_auto] sm:items-baseline sm:gap-4"
            >
              <span className="min-w-0">
                <span className="font-semibold underline-offset-4 hover:underline">
                  {hearing.city || "Commune à confirmer"}
                  {hearing.department ? ` (${hearing.department})` : ""}
                </span>
                <span className="block text-sm text-ink-soft">
                  {propertyTypeLabel(hearing.propertyType)} ·{" "}
                  {hearing.time ? `à ${hearing.time}` : "heure à confirmer"}
                </span>
              </span>
              <span className="text-sm tabular-nums">
                <span className="text-ink-soft">Mise à prix </span>
                <span className="font-semibold">
                  {formatStartingPrice(hearing.startingPriceEur)}
                </span>
              </span>
            </SaleDetailLink>
          ),
        })),
      };
    }),
  };
}

/**
 * Les audiences mises en page par le serveur (lien de chaque fiche, tribunal, prix, libellés) :
 * le filtre par département, qui s'exécute dans le navigateur, ne reçoit que ces lignes déjà
 * prêtes et ne charge ni le formatage ni le calcul des audiences (budget de JavaScript initial).
 */
export function listHearings(
  windows: HearingWindows,
  tribunalPaths: Readonly<Record<string, string>>,
): ListedWindows {
  return {
    weekDays: HEARINGS_WEEK_DAYS,
    windowDays: HEARINGS_WINDOW_DAYS,
    week: windows.week.map((day) => listDay(day, tribunalPaths)),
    later: windows.later.map((day) => listDay(day, tribunalPaths)),
  };
}
