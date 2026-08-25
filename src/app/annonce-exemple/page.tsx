import type { Metadata } from "next";
import { Suspense } from "react";
import { ExampleSalePage } from "@/routes/annonce-exemple";

export const metadata: Metadata = {
  title: "Annonce exemple",
  description: "Exemple de fiche analysee Immojudis.",
  alternates: { canonical: "/annonce-exemple" },
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense fallback={<ExampleFallback />}>
      <ExampleSalePage />
    </Suspense>
  );
}

function ExampleFallback() {
  return (
    <main className="min-h-screen bg-[#f7f5f3] px-4 py-12 text-foreground">
      <section className="mx-auto max-w-4xl rounded-lg border border-border bg-white p-8 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-soft">
          Démonstration
        </p>
        <h1 className="mt-3 font-display text-4xl">Exemple de rapport d’opportunité</h1>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          Découvrez la lecture ImmoJudis d’une vente judiciaire : prix, marché, frais, risques et
          plafond d’enchère.
        </p>
      </section>
    </main>
  );
}
