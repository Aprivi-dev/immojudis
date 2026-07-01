import type { Property } from "@/lib/property-types";

export function FactsGrid({ facts }: { facts: Property["facts"] }) {
  if (!facts.length) {
    return (
      <div className="rounded-md border border-border bg-muted/35 p-4 text-sm text-muted-foreground">
        Les caracteristiques seront completees des qu'elles seront disponibles.
      </div>
    );
  }

  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {facts.map((fact) => (
        <div key={fact.label} className="rounded-md border border-border bg-white p-4">
          <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {fact.label}
          </dt>
          <dd className="mt-1 text-base font-semibold text-foreground">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
