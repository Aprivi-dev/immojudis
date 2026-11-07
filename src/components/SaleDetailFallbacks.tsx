import { BrandMark } from "@/components/BrandMark";
import { Skeleton } from "@/components/ui/skeleton";
import Link from "next/link";
import { Card, Eyebrow, buttonClasses } from "@/components/ui/primitives";

export function SaleDetailSkeleton() {
  return (
    <main id="contenu" className="min-h-screen bg-white px-4 py-8 sm:px-6">
      {/* The status role goes on a child so that the page keeps its « main » landmark. */}
      <div role="status" aria-label="Chargement de la fiche" className="mx-auto max-w-7xl">
        <Skeleton className="h-4 w-20 bg-muted" />
        <Skeleton className="mt-4 h-8 w-2/3 bg-muted" />
        <Skeleton className="mt-2 h-4 w-1/2 bg-muted" />
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Skeleton className="h-96 w-full rounded-lg bg-muted" />
            <Skeleton className="h-40 w-full rounded-lg bg-muted" />
            <Skeleton className="h-32 w-full rounded-lg bg-muted" />
          </div>
          <aside className="space-y-4">
            <Skeleton className="h-48 w-full rounded-lg bg-muted" />
            <Skeleton className="h-32 w-full rounded-lg bg-muted" />
          </aside>
        </div>
      </div>
    </main>
  );
}

/**
 * « Annonce introuvable » : rendue par `app/sales/[id]/not-found.tsx` (identifiant inconnu côté
 * serveur, vraie 404) et par la fiche quand la vente disparaît côté navigateur. Le `h1` reprend le
 * titre de l'onglet (« Annonce introuvable », `generateMetadata`) : repasse design n° 46.
 */
export function SaleNotFoundComponent() {
  return (
    <main id="contenu" className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6 sm:py-24">
      <Card className="text-center sm:!p-10">
        <BrandMark decorative className="mx-auto h-14 w-14" />
        <Eyebrow className="mt-5">Erreur 404</Eyebrow>
        <h1 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">
          Annonce introuvable
        </h1>
        <p className="mx-auto mt-3 max-w-md text-ink-soft">
          Cette vente n’existe plus ou a été retirée. Elle peut avoir été adjugée ou supprimée par
          la source.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/sales" className={buttonClasses({ variant: "primary" })}>
            Voir les ventes
          </Link>
          <Link href="/" className={buttonClasses()}>
            Retour à l’accueil
          </Link>
        </div>
      </Card>
    </main>
  );
}
