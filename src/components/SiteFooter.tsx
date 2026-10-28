"use client";

import Link from "next/link";
import { BrandMark } from "@/components/BrandMark";
import { usePublicPathname } from "@/hooks/use-public-pathname";
import { publicLegalPublisher } from "@/lib/legal-documents";
import { linkPrefetch } from "@/lib/navigation";

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
] as const;

/** Console pages bring their own shell and must not show the public footer. */
export function showsSiteFooter(pathname: string | null): boolean {
  return !(pathname === "/admin" || pathname?.startsWith("/admin/"));
}

export function SiteFooter() {
  const pathname = usePublicPathname();
  if (!showsSiteFooter(pathname)) return null;
  const entityName = publicLegalPublisher().entityName ?? "Immojudis";

  return (
    <footer className="mt-16 border-t border-border bg-card text-sm text-muted-foreground">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <Link
              href="/"
              className="inline-flex items-center gap-2 font-display text-xl font-semibold text-foreground"
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
            <ul className="flex flex-wrap gap-x-5 gap-y-2">
              {MAIN_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    prefetch={linkPrefetch(link.href)}
                    className="hover:text-foreground hover:underline"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <nav aria-label="Transparence" className="border-t border-border pt-5">
          <p className="mb-2 font-semibold text-foreground">Transparence</p>
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {TRANSPARENCY_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="hover:text-foreground hover:underline">
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
            <ul className="flex flex-wrap gap-x-5 gap-y-2">
              {LEGAL_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="hover:text-foreground hover:underline">
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
