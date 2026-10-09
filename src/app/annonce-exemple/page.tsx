import type { Metadata } from "next";
import { Suspense } from "react";
import { EXAMPLE_SALE_RECORDS } from "@/lib/example-sale";
import { ExampleSalePage } from "@/routes/annonce-exemple";

export const metadata: Metadata = {
  title: "Annonce exemple",
  description: "Exemple de fiche analysée Immojudis.",
  alternates: { canonical: "/annonce-exemple" },
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense fallback={<ExampleFallback />}>
      <ExampleSalePage examples={EXAMPLE_SALE_RECORDS} />
    </Suspense>
  );
}

function ExampleFallback() {
  return (
    <main className="min-h-screen bg-surface-muted px-4 py-12 text-foreground">
      <section className="mx-auto max-w-4xl rounded-lg border border-border bg-white p-8 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-text">
          Démonstration
        </p>
        <h1 className="mt-3 font-display text-4xl">Exemple de rapport d’opportunité</h1>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          Découvrez la lecture Immojudis d’une vente judiciaire : prix, marché, frais, risques et
          enchère plafond.
        </p>
      </section>
    </main>
  );
}
