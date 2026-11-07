import type { ReactNode } from "react";

const count = new Intl.NumberFormat("fr-FR");

/**
 * Répartition en barres proportionnelles (types de bien, communes) : un libellé, son nombre, et
 * une barre dont la longueur rapporte ce nombre au plus grand de la liste.
 */
export function ProportionalBars({
  items,
  unit,
}: {
  items: ReadonlyArray<{ key: string; label: ReactNode; count: number }>;
  /** Mot lu après le nombre par un lecteur d'écran (« ventes »). */
  unit: (value: number) => string;
}) {
  const max = Math.max(1, ...items.map((item) => item.count));
  return (
    <ul className="mt-3 grid gap-2.5">
      {items.map((item) => (
        <li key={item.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-sm">
          <span className="min-w-0">{item.label}</span>
          <span className="font-bold tabular-nums">
            {count.format(item.count)}
            <span className="sr-only"> {unit(item.count)}</span>
          </span>
          <span aria-hidden className="col-span-2 h-1.5 overflow-hidden rounded-full bg-line-soft">
            <span
              className="block h-full rounded-full bg-brand-navy"
              style={{ width: `${((item.count / max) * 100).toFixed(1)}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}
