import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SaleComparisonTable } from "@/components/search/SaleComparisonTable";
import { Eyebrow, PageTitle } from "@/components/ui/primitives";
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
          <Eyebrow>Comparaison partagée Immojudis</Eyebrow>
          <PageTitle className="mt-2">{comparison.name}</PageTitle>
          <p className="mt-2 text-sm text-ink-soft">
            Instantané mis à jour le {formatDate(comparison.updatedAt)} · lien valable jusqu’au{" "}
            {formatDate(comparison.expiresAt)}
          </p>
        </header>

        {comparison.withdrawnCount > 0 ? (
          <p
            role="status"
            data-testid="withdrawn-sales-notice"
            className="border-b border-line-soft bg-surface-muted px-4 py-3 text-sm text-ink-soft sm:px-6"
          >
            {comparison.withdrawnCount === 1
              ? "1 vente retirée du catalogue depuis le partage de cette comparaison."
              : `${comparison.withdrawnCount} ventes retirées du catalogue depuis le partage de cette comparaison.`}
          </p>
        ) : null}

        {/* « Retour à la comparaison » sur la fiche : `saleDetailPath` ne garde qu'un jeton valide. */}
        <SaleComparisonTable items={comparison.items} returnTo={`/comparaisons/${token}`} />

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
          <p>
            Cette comparaison a été préparée avec Immojudis.{" "}
            <Link
              href="/annonce-exemple"
              className="inline-flex min-h-11 items-center font-bold text-brand-navy underline underline-offset-2"
            >
              Voir une analyse exemple
            </Link>
          </p>
        </footer>
      </article>
    </main>
  );
}
