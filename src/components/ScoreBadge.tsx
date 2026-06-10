import { scoreBand, confidenceLabel, confidenceLevel } from "@/lib/score";

type Size = "sm" | "md" | "lg";

type Props = {
  score: number | null | undefined;
  className?: string;
  /** 0..1 — drives the confidence indicator (never colour-only). */
  confidence?: number | null;
  size?: Size;
  /** Show the band label + confidence next to the ring. */
  showLabel?: boolean;
};

const RING = {
  sm: { box: 44, stroke: 4, font: "text-sm" },
  md: { box: 60, stroke: 5, font: "text-lg" },
  lg: { box: 96, stroke: 6, font: "text-3xl" },
} as const;

/**
 * Immojudis Score — signature radial gauge. Communicates the value, the decision
 * band (label + colour) and the confidence in the underlying data. The ring is
 * always paired with text so the meaning never relies on colour alone.
 */
export function ScoreBadge({
  score,
  className = "",
  confidence,
  size = "sm",
  showLabel = false,
}: Props) {
  if (score == null) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--signal-missing)] ${className}`}
        title="Donnée manquante : ce dossier n'a pas encore de score Immojudis."
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
        Non scoré
      </span>
    );
  }

  const rounded = Math.round(score);
  const band = scoreBand(score);
  const conf = confidenceLevel(confidence);
  const confText = confidenceLabel(confidence);
  const dims = RING[size];
  const r = (dims.box - dims.stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, rounded)) / 100;
  const ariaLabel = `Score Immojudis ${rounded} sur 100, ${band.label}${
    confText ? `, ${confText.toLowerCase()}` : ""
  }`;

  return (
    <span
      role="img"
      aria-label={ariaLabel}
      title={ariaLabel}
      className={`inline-flex items-center gap-2.5 ${className}`}
    >
      <span
        className="relative inline-grid shrink-0 place-items-center"
        style={{ width: dims.box, height: dims.box, color: band.colorVar }}
      >
        <svg
          width={dims.box}
          height={dims.box}
          viewBox={`0 0 ${dims.box} ${dims.box}`}
          className="-rotate-90"
          aria-hidden
        >
          <circle
            cx={dims.box / 2}
            cy={dims.box / 2}
            r={r}
            fill="none"
            stroke="rgb(255 255 255 / 12%)"
            strokeWidth={dims.stroke}
          />
          <circle
            cx={dims.box / 2}
            cy={dims.box / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={dims.stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - pct)}
            className="score-ring-arc"
            style={{ ["--ring-c" as string]: String(c) }}
          />
        </svg>
        <span
          className={`absolute font-display tabular-nums leading-none text-foreground ${dims.font}`}
        >
          {rounded}
        </span>
        {conf === "low" && (
          <span
            className="absolute -right-0.5 -top-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full border border-background bg-[var(--signal-watch)] text-[9px] font-bold text-background"
            aria-hidden
          >
            !
          </span>
        )}
      </span>

      {showLabel && (
        <span className="flex flex-col gap-0.5 text-left">
          <span
            className="text-xs font-semibold uppercase tracking-[0.14em]"
            style={{ color: band.colorVar }}
          >
            {band.label}
          </span>
          {confText && (
            <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {confText}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
