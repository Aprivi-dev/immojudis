import Link from "next/link";

export function Footer() {
  return (
    <footer className="border-t border-border bg-white pb-24 lg:pb-0">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-8 text-sm text-muted-foreground sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <p>Immojudis · Fiche immobiliere de demonstration</p>
        <nav className="flex flex-wrap gap-4" aria-label="Liens de pied de page">
          <Link href="/legal" className="transition-colors hover:text-gold-text">
            Mentions legales
          </Link>
          <Link href="/conditions-generales" className="transition-colors hover:text-gold-text">
            Conditions generales
          </Link>
          <Link href="/privacy" className="transition-colors hover:text-gold-text">
            Confidentialite
          </Link>
          <Link href="/mes-droits" className="transition-colors hover:text-gold-text">
            Mes droits
          </Link>
          <Link href="/contact" className="transition-colors hover:text-gold-text">
            Contact
          </Link>
        </nav>
      </div>
    </footer>
  );
}
