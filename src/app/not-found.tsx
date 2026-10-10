import type { Metadata } from "next";
import Link from "next/link";
import Search from "lucide-react/dist/esm/icons/search.js";
import { Card, Eyebrow, buttonClasses } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Page introuvable" };

export default function NotFound() {
  return (
    <main id="contenu" className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6 sm:py-24">
      <Card className="text-center sm:!p-10">
        <Eyebrow>Erreur 404</Eyebrow>
        <h1 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">Page introuvable</h1>
        <p className="mx-auto mt-3 max-w-md text-ink-soft">
          La page demandée n’existe pas ou a été déplacée. Cherchez une vente par ville, département
          ou région, ou revenez à l’accueil.
        </p>
        <form action="/sales" role="search" className="mx-auto mt-6 flex max-w-md gap-2">
          <label htmlFor="not-found-search" className="sr-only">
            Rechercher une vente par ville, département ou région
          </label>
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-white px-3 focus-within:ring-2 focus-within:ring-gold">
            <Search className="size-4 shrink-0 text-ink-soft" aria-hidden />
            <input
              id="not-found-search"
              name="q"
              type="search"
              autoComplete="off"
              placeholder="Ville, département ou région"
              className="min-h-11 w-full min-w-0 bg-transparent text-sm outline-none"
            />
          </div>
          <button type="submit" className={buttonClasses({ variant: "dark" })}>
            Rechercher
          </button>
        </form>
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
