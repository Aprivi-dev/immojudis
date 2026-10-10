import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SaleComparisonTable } from "@/components/search/SaleComparisonTable";
import { formatDate } from "@/lib/format";
import { getSharedSaleComparison } from "@/lib/sale-analysis-sets";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Comparaison partagée",
  description: "Comparaison de biens issue du catalogue Immojudis.",
  robots: { index: false, follow: false },
};

export default async function SharedSaleComparisonPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const comparison = await getSharedSaleComparison(token).catch(() => null);
  if (!comparison) notFound();

  return (
    <main id="contenu" className="min-h-screen bg-surface-muted px-3 py-8 text-brand-navy sm:px-6">
      <article className="mx-auto max-w-5xl overflow-hidden rounded-xl border border-line-soft bg-white shadow-sm">
        <header className="border-b border-line-soft px-4 py-5 sm:px-6">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-navy">
            Comparaison partagée Immojudis
          </p>
          <h1 className="mt-2 text-2xl font-extrabold sm:text-3xl">{comparison.name}</h1>
          <p className="mt-2 text-sm text-ink-soft">
            Instantané mis à jour le {formatDate(comparison.updatedAt)} · lien valable jusqu’au{" "}
            {formatDate(comparison.expiresAt)}
          </p>
        </header>

        <SaleComparisonTable items={comparison.items} returnTo="/sales" />

        <footer className="space-y-2 border-t border-line-soft bg-white px-4 py-4 text-xs leading-relaxed text-ink-soft sm:px-6">
          <p>
            Cet instantané contient seulement des informations publiques du catalogue. Il n’inclut
            ni score d’investissement, ni adresse détaillée, ni donnée personnelle.
          </p>
          <p>
            La mise à prix n’est ni le prix final ni le coût total. Vérifiez les pièces officielles
            et la disponibilité des biens avant toute décision.
          </p>
          <a
            href="/sales"
            className="inline-flex min-h-11 items-center font-bold text-brand-navy underline underline-offset-2"
          >
            Explorer le catalogue
          </a>
        </footer>
      </article>
    </main>
  );
}
