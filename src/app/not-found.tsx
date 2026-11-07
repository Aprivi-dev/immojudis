import type { Metadata } from "next";
import Link from "next/link";
import Search from "lucide-react/dist/esm/icons/search.js";
import { StatusPage } from "@/components/StatusPage";
import { buttonClasses } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Page introuvable" };

export default function NotFound() {
  return (
    <StatusPage
      eyebrow="Erreur 404"
      title="Page introuvable"
      description="La page demandée n’existe pas ou a été déplacée. Cherchez une vente par ville, département ou région, ou revenez à l’accueil."
      actions={
        <>
          <Link href="/sales" className={buttonClasses({ variant: "primary" })}>
            Voir les ventes
          </Link>
          <Link href="/" className={buttonClasses()}>
            Retour à l’accueil
          </Link>
        </>
      }
    >
      <form action="/sales" role="search" className="mx-auto mt-6 flex max-w-md gap-2">
        <label htmlFor="not-found-search" className="sr-only">
          Rechercher une vente par ville, département ou région
        </label>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-white px-3 focus-within:outline-2 focus-within:outline-gold-soft">
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
    </StatusPage>
  );
}
