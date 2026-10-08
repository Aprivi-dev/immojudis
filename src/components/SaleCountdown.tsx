import Clock from "lucide-react/dist/esm/icons/clock.js";
import { useEffect, useState } from "react";
import {
  calendarDaysBetween,
  parisDateKey,
  resolveSaleCountdownTarget,
} from "@/lib/sale-countdown";
import type { AuctionSale } from "@/lib/types";

function diffParts(target: number, now: number) {
  const ms = target - now;
  if (ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  return { days, hours, minutes, ms };
}

function tone(days: number | null): {
  bg: string;
  text: string;
  ring: string;
} {
  if (days == null) return { bg: "bg-muted", text: "text-muted-foreground", ring: "ring-border" };
  if (days < 7)
    return {
      bg: "bg-red-100 dark:bg-red-900/30",
      text: "text-red-900 dark:text-red-200",
      ring: "ring-red-300/50",
    };
  if (days < 30)
    return {
      bg: "bg-amber-100 dark:bg-amber-900/30",
      text: "text-amber-900 dark:text-amber-200",
      ring: "ring-amber-300/50",
    };
  return {
    bg: "bg-emerald-100 dark:bg-emerald-900/30",
    text: "text-emerald-900 dark:text-emerald-200",
    ring: "ring-emerald-300/50",
  };
}

export function SaleCountdown({
  sale,
  precisionUnknown = false,
  variant = "chip",
}: {
  sale: AuctionSale;
  precisionUnknown?: boolean;
  variant?: "chip" | "block";
}) {
  const resolved = resolveSaleCountdownTarget(sale, { precisionUnknown });
  const targetMs = resolved?.target?.getTime() ?? null;
  const valid = targetMs != null && Number.isFinite(targetMs);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!valid) return;
    setNow(Date.now());
    const i = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(i);
  }, [targetMs, valid]);

  if (!valid) {
    if (variant === "chip") {
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          <Clock className="h-3 w-3" /> Échéance à confirmer
        </span>
      );
    }
    return (
      <div className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
        Échéance à confirmer
      </div>
    );
  }

  if (now == null) {
    return variant === "chip" ? null : (
      <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
        Calcul du délai…
      </div>
    );
  }

  const parts = diffParts(targetMs, now);
  const dayRemaining =
    resolved?.kind === "day" && resolved.dateOnly
      ? calendarDaysBetween(parisDateKey(new Date(now)), resolved.dateOnly)
      : null;

  if (resolved?.kind === "day" && dayRemaining != null) {
    if (dayRemaining < 0 || !parts) {
      return resolved.deadlineKnown === false ? (
        <Confirmation variant={variant} />
      ) : (
        <PastSale variant={variant} />
      );
    }

    const t = tone(dayRemaining);
    const label =
      dayRemaining === 0
        ? "Aujourd'hui · heure à confirmer"
        : `${dayRemaining} jours · heure à confirmer`;

    if (variant === "chip") {
      return (
        <span
          className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold ring-1 ${t.bg} ${t.text} ${t.ring}`}
        >
          <Clock className="h-3 w-3" /> {label}
        </span>
      );
    }

    return (
      <div className={`rounded-lg p-3 ring-1 ${t.bg} ${t.text} ${t.ring}`}>
        <div className="flex items-center gap-2 text-xs font-medium opacity-80">
          <Clock className="h-3.5 w-3.5" /> Date de vente
        </div>
        <div className="mt-1 text-sm font-semibold">{label}</div>
      </div>
    );
  }

  const t = tone(parts ? parts.days : null);

  if (!parts) {
    return <PastSale variant={variant} />;
  }

  if (variant === "chip") {
    const compact =
      parts.days > 0
        ? `J-${parts.days}`
        : parts.hours > 0
          ? `${parts.hours}h ${parts.minutes}m`
          : `${parts.minutes} min`;
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold ring-1 ${t.bg} ${t.text} ${t.ring}`}
      >
        <Clock className="h-3 w-3" /> {compact}
      </span>
    );
  }

  return (
    <div className={`rounded-lg p-3 ring-1 ${t.bg} ${t.text} ${t.ring}`}>
      <div className="flex items-center gap-2 text-xs font-medium opacity-80">
        <Clock className="h-3.5 w-3.5" />
        {resolved?.kind === "window" ? "Temps avant la clôture" : "Temps avant la vente"}
      </div>
      <div className="mt-1 flex items-baseline gap-3 tabular-nums">
        <Stat n={parts.days} label="jours" />
        <Stat n={parts.hours} label="h" />
        <Stat n={parts.minutes} label="min" />
      </div>
    </div>
  );
}

function Confirmation({ variant }: { variant: "chip" | "block" }) {
  if (variant === "chip") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
        <Clock className="h-3 w-3" /> Échéance à confirmer
      </span>
    );
  }
  return (
    <div className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
      Échéance à confirmer
    </div>
  );
}

function PastSale({ variant }: { variant: "chip" | "block" }) {
  if (variant === "chip") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
        <Clock className="h-3 w-3" /> Vente passée
      </span>
    );
  }
  return (
    <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">Vente passée</div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-xl font-bold leading-none">{n}</span>
      <span className="text-xs opacity-70">{label}</span>
    </div>
  );
}
