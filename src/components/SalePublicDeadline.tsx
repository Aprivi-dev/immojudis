"use client";

import Clock from "lucide-react/dist/esm/icons/clock.js";
import { useSyncExternalStore } from "react";
import { Badge, type BadgeTone } from "@/components/ui/primitives";
import { calendarDaysBetween } from "@/lib/calendar-day";
import { parisDateKey } from "@/lib/paris-time";
import { resolveSaleCountdownTarget } from "@/lib/sale-countdown";
import { saleHearingTime } from "@/lib/seo";
import type { AuctionSale } from "@/lib/types";

export type SaleDeadline = { label: string; tone: BadgeTone };

/**
 * Échéance d'une vente, en clair : « Aujourd'hui à 12 h 00 », « Demain », « Dans 12 jours ». Mêmes
 * règles que le compte à rebours des cartes (`resolveSaleCountdownTarget` : fenêtre de clôture, jour
 * seul, instant) et les tons des fondations (docs/design/fondations.md) : `danger` le jour même,
 * `warning` à sept jours ou moins, neutre au-delà. Une vente dont le jour est passé, ou dont
 * l'échéance n'est pas connue, n'a pas de pastille (la date passée est signalée ailleurs).
 */
export function saleDeadline(sale: AuctionSale, now: Date): SaleDeadline | null {
  const resolved = resolveSaleCountdownTarget(sale);
  if (!resolved?.target || !Number.isFinite(resolved.target.getTime())) return null;
  if (resolved.kind === "day" && resolved.deadlineKnown === false) return null;
  // Jour seul : la cible est le minuit qui suit ce jour ; le jour lui-même est `dateOnly`.
  const day = resolved.dateOnly ?? parisDateKey(resolved.target);
  const days = calendarDaysBetween(parisDateKey(now), day);
  if (days == null || days < 0) return null;
  if (resolved.kind === "window" && resolved.target.getTime() <= now.getTime()) return null;

  const time = resolved.kind === "instant" ? saleHearingTime(sale.sale_date) : null;
  const tone: BadgeTone = days === 0 ? "danger" : days <= 7 ? "warning" : "neutral";
  if (resolved.kind === "window") {
    const label =
      days === 0
        ? "Clôture aujourd’hui"
        : days === 1
          ? "Clôture demain"
          : `Clôture dans ${days} jours`;
    return { label, tone };
  }
  if (days === 0) {
    return { label: time ? `Aujourd’hui à ${time}` : "Aujourd’hui · heure à confirmer", tone };
  }
  if (days === 1) return { label: time ? `Demain à ${time}` : "Demain", tone };
  return { label: `Dans ${days} jours`, tone };
}

/** Rien à écouter : l'heure n'est lue qu'une fois le navigateur monté. */
const subscribeNever = () => () => undefined;

/**
 * Pastille d'échéance de l'en-tête. Calculée après l'hydratation seulement : le serveur (page mise en
 * cache une heure) et le navigateur n'ont pas la même heure, et une pastille différente d'un côté à
 * l'autre ferait échouer l'hydratation. Le serveur ne rend donc rien ; la ligne des pastilles a déjà
 * sa hauteur (type de vente), la pastille n'y décale rien.
 */
export function SalePublicDeadline({ sale }: { sale: AuctionSale }) {
  const now = useSyncExternalStore(
    subscribeNever,
    () => currentMinute(),
    () => null,
  );
  if (now == null) return null;
  const deadline = saleDeadline(sale, new Date(now));
  if (!deadline) return null;
  return (
    <Badge tone={deadline.tone} data-testid="public-sale-deadline">
      <Clock className="h-3.5 w-3.5" aria-hidden />
      {deadline.label}
    </Badge>
  );
}

/** Instantané stable pendant une minute : `useSyncExternalStore` exige la même valeur d'un appel à l'autre. */
function currentMinute(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}
