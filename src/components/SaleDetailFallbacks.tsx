import { BrandMark } from "@/components/BrandLogo";
import { Skeleton } from "@/components/ui/skeleton";
import Link from "next/link";

export function SaleDetailSkeleton() {
  return (
    <main id="contenu" className="min-h-screen bg-white px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-7xl">
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

export function SaleNotFoundComponent() {
  return (
    <main
      id="contenu"
      className="flex min-h-screen items-center justify-center bg-white px-4 py-16 text-center"
    >
      <div className="max-w-2xl rounded-lg border border-border bg-white p-8 shadow-xl shadow-slate-900/10">
        <BrandMark className="mx-auto h-14 w-14" />
        <h1 className="mt-5 font-sans text-2xl font-semibold text-foreground">
          Annonce introuvable
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Cette vente n&apos;existe plus ou a été retirée. Elle peut avoir été adjugée ou supprimée
          par la source.
        </p>
        <Link
          href="/sales"
          className="mt-6 inline-flex items-center rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-foreground/90"
        >
          ← Retour aux annonces
        </Link>
      </div>
    </main>
  );
}
