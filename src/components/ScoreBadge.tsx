type Props = {
  score: number | null | undefined;
  className?: string;
  /** 0..1 — si fourni et faible, affiche un point d'alerte */
  confidence?: number | null;
};

export function ScoreBadge({ score, className = "", confidence }: Props) {
  if (score == null) {
    return (
      <span
        className={`inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground ${className}`}
      >
        Pas de score
      </span>
    );
  }
  const rounded = Math.round(score);
  let label = "Risqué";
  let cls = "bg-destructive/10 text-destructive";
  if (score >= 80) {
    label = "Excellent";
    cls = "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
  } else if (score >= 60) {
    label = "Intéressant";
    cls = "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
  } else if (score >= 40) {
    label = "Moyen";
    cls = "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
  }
  const lowConf = confidence != null && confidence < 0.5;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold ${cls} ${className}`}
      title={lowConf ? "Score basé sur des données partielles ou peu recoupées" : undefined}
    >
      <span className="tabular-nums">{rounded}</span>
      <span className="font-normal opacity-80">· {label}</span>
      {lowConf && (
        <span
          className="ml-0.5 inline-flex h-3 w-3 items-center justify-center rounded-full bg-amber-500/80 text-[8px] font-bold text-white"
          aria-label="Confiance faible"
        >
          !
        </span>
      )}
    </span>
  );
}
