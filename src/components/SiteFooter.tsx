"use client";

import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { usePublicPathname } from "@/hooks/use-public-pathname";
import { publicLegalPublisher } from "@/lib/legal-documents";

const MAIN_LINKS = [
  { href: "/sales", label: "Ventes" },
  { href: "/tribunaux", label: "Tribunaux" },
  { href: "/audiences-a-venir", label: "Audiences à venir" },
  { href: "/ventes-encheres-immobilieres", label: "Par département" },
  { href: "/avocats", label: "Avocats" },
  { href: "/ressources", label: "Ressources" },
  { href: "/comment-ca-marche", label: "Comment ça marche" },
  { href: "/offres", label: "Offres" },
  { href: "/contact", label: "Contact" },
] as const;

/**
 * Groupe « Ventes par type » : les pages par type de bien ou de vente. Adresses écrites ici (le module
 * `sale-landing-pages.ts` n'entre pas dans le JavaScript du navigateur) ; un test vérifie qu'elles
 * sont celles de `SALE_LANDING_PAGES`, dans le même ordre.
 */
const SALE_TYPE_LINKS = [
  { href: "/maison-aux-encheres", label: "Maisons aux enchères" },
  { href: "/appartement-aux-encheres", label: "Appartements aux enchères" },
  { href: "/encheres-notariales", label: "Enchères notariales" },
  { href: "/ventes-immobilieres-etat", label: "Ventes immobilières de l’État" },
] as const;

/** Groupe « Transparence » : qui nous sommes, le guide, le simulateur et les méthodes de calcul. */
const TRANSPARENCY_LINKS = [
  { href: "/a-propos", label: "À propos" },
  { href: "/ventes-immobilieres-judiciaires", label: "Guide des ventes judiciaires" },
  { href: "/simulateur-frais-encheres", label: "Simulateur de frais" },
  { href: "/methode-ecart-marche", label: "Méthode de l’écart avec le marché" },
  { href: "/methode-pepites", label: "Méthode Pépite" },
] as const;

const LEGAL_LINKS = [
  { href: "/legal", label: "Mentions légales" },
  { href: "/conditions-generales", label: "Conditions générales" },
  { href: "/privacy", label: "Confidentialité" },
  { href: "/privacy#cookies", label: "Gérer les cookies" },
  { href: "/classement-des-annonces", label: "Classement des annonces" },
  { href: "/mes-droits", label: "Mes droits" },
  { href: "/accessibilite", label: "Accessibilité : non évalué" },
] as const;

/** Console pages bring their own shell and must not show the public footer. */
export function showsSiteFooter(pathname: string | null): boolean {
  return !(pathname === "/admin" || pathname?.startsWith("/admin/"));
}

export function SiteFooter() {
  const pathname = usePublicPathname();
  if (!showsSiteFooter(pathname)) return null;
  const entityName = publicLegalPublisher().entityName ?? "Immojudis";
  // L'accueil finit sur un bandeau pleine largeur : la marge haute y laisserait une bande vide.
  const endsOnBand = pathname === "/";

  return (
    <footer
      className={`${endsOnBand ? "" : "mt-16 "}border-t border-border bg-card text-sm text-muted-foreground`}
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <Link
              href="/"
              prefetch={false}
              className="inline-flex min-h-11 items-center gap-2 font-display text-xl font-semibold text-foreground"
            >
              <span aria-hidden className="inline-flex">
                <BrandMark className="size-7" />
              </span>
              <span>
                Immo<span className="text-gold-text">judis</span>
              </span>
            </Link>
            <p className="mt-1">Les enchères immobilières, en toute clarté.</p>
          </div>
          <nav aria-label="Navigation pied de page">
            <ul className="flex flex-wrap gap-x-5">
              {MAIN_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    prefetch={false}
                    className="inline-flex min-h-11 items-center hover:text-foreground hover:underline"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <nav aria-label="Ventes par type" className="border-t border-border pt-5">
          <p className="mb-2 font-semibold text-foreground">Ventes par type</p>
          <ul className="flex flex-wrap gap-x-5">
            {SALE_TYPE_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  prefetch={false}
                  className="inline-flex min-h-11 items-center hover:text-foreground hover:underline"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Transparence" className="border-t border-border pt-5">
          <p className="mb-2 font-semibold text-foreground">Transparence</p>
          <ul className="flex flex-wrap gap-x-5">
            {TRANSPARENCY_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  prefetch={false}
                  className="inline-flex min-h-11 items-center hover:text-foreground hover:underline"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
          <span>
            © {new Date().getFullYear()} {entityName}
          </span>
          <nav aria-label="Informations légales">
            <ul className="flex flex-wrap gap-x-5">
              {LEGAL_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    prefetch={false}
                    className="inline-flex min-h-11 items-center hover:text-foreground hover:underline"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    </footer>
  );
}
