import type { Property } from "@/lib/property-types";
import { formatCurrency, formatDate } from "@/lib/format";
import { AnimatedSection } from "./AnimatedSection";

export function PriceHistorySection({ property }: { property: Property }) {
  const rows = property.priceHistory ?? [];

  return (
    <AnimatedSection id="price-history" aria-labelledby="price-history-title">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-soft">
          Historique
        </p>
        <h2 id="price-history-title" className="mt-2 font-display text-3xl text-foreground">
          Historique des prix
        </h2>
      </div>
      <div className="mt-5 overflow-hidden rounded-md border border-border bg-white">
        {rows.length ? (
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/35 text-xs uppercase tracking-[0.12em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-semibold">Date</th>
                <th className="px-4 py-3 font-semibold">Evenement</th>
                <th className="px-4 py-3 font-semibold">Prix</th>
                <th className="px-4 py-3 font-semibold">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={`${row.date}-${row.event}`}>
                  <td className="px-4 py-3 text-muted-foreground">{formatDate(row.date)}</td>
                  <td className="px-4 py-3 font-semibold text-foreground">{row.event}</td>
                  <td className="px-4 py-3 text-foreground">
                    {row.price != null ? formatCurrency(row.price, property.currency) : "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{row.source ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="p-5 text-sm text-muted-foreground">Aucun historique disponible.</div>
        )}
      </div>
    </AnimatedSection>
  );
}
