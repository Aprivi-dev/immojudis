import Clock from "lucide-react/dist/esm/icons/clock.js";
import { useEffect, useState } from "react";

function diffParts(target: Date) {
  const ms = target.getTime() - Date.now();
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
  date,
  variant = "chip",
}: {
  date: string | null | undefined;
  variant?: "chip" | "block";
}) {
  const target = date ? new Date(date) : null;
  const valid = target && !isNaN(target.getTime());
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!valid) return;
    const i = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(i);
  }, [valid]);

  if (!valid) {
    if (variant === "chip") return null;
    return (
      <div className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
        Date à confirmer
      </div>
    );
  }

  const parts = diffParts(target!);
  const t = tone(parts ? parts.days : null);

  if (!parts) {
    if (variant === "chip") {
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          <Clock className="h-3 w-3" /> Vente passée
        </span>
      );
    }
    return (
      <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
        Vente passée
      </div>
    );
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
        <Clock className="h-3.5 w-3.5" /> Temps avant la vente
      </div>
      <div className="mt-1 flex items-baseline gap-3 tabular-nums">
        <Stat n={parts.days} label="jours" />
        <Stat n={parts.hours} label="h" />
        <Stat n={parts.minutes} label="min" />
      </div>
    </div>
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
