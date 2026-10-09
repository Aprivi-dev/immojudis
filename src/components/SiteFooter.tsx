"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { publicLegalPublisher } from "@/lib/legal-documents";

const MAIN_LINKS = [
  { href: "/sales", label: "Ventes" },
  { href: "/tribunaux", label: "Tribunaux" },
  { href: "/avocats", label: "Avocats" },
  { href: "/ressources", label: "Ressources" },
  { href: "/comment-ca-marche", label: "Comment ça marche" },
  { href: "/offres", label: "Offres" },
  { href: "/contact", label: "Contact" },
] as const;

const LEGAL_LINKS = [
  { href: "/legal", label: "Mentions légales" },
  { href: "/conditions-generales", label: "Conditions générales" },
  { href: "/privacy", label: "Confidentialité" },
  { href: "/mes-droits", label: "Mes droits" },
] as const;

/** Console pages bring their own shell and must not show the public footer. */
export function showsSiteFooter(pathname: string | null): boolean {
  return !(pathname === "/admin" || pathname?.startsWith("/admin/"));
}

export function SiteFooter() {
  const pathname = usePathname();
  if (!showsSiteFooter(pathname)) return null;
  const entityName = publicLegalPublisher().entityName ?? "Immojudis";

  return (
    <footer className="mt-16 border-t border-border bg-card text-sm text-muted-foreground">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <Link href="/" className="font-display text-xl font-semibold text-foreground">
              Immo<span className="text-gold-text">judis</span>
            </Link>
            <p className="mt-1">Les ventes immobilières en toute clarté.</p>
          </div>
          <nav aria-label="Navigation pied de page">
            <ul className="flex flex-wrap gap-x-5 gap-y-2">
              {MAIN_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="hover:text-foreground hover:underline">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
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
