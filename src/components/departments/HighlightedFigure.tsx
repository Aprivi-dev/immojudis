import type { ReactNode } from "react";

/** Chiffre surligné en bloc marine dans un titre-phrase (« 833 ventes… »). */
export function HighlightedFigure({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-sm bg-brand-navy px-[0.3em] text-white tabular-nums [box-decoration-break:clone] [-webkit-box-decoration-break:clone]">
      {children}
    </span>
  );
}
