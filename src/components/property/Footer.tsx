import { Link } from "@/lib/router-compat";

export function Footer() {
  return (
    <footer className="border-t border-border bg-white pb-24 lg:pb-0">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-8 text-sm text-muted-foreground sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <p>Immojudis · Fiche immobiliere de demonstration</p>
        <nav className="flex flex-wrap gap-4" aria-label="Liens de pied de page">
          <Link to="/legal" className="transition-colors hover:text-gold-soft">
            Mentions legales
          </Link>
          <Link to="/privacy" className="transition-colors hover:text-gold-soft">
            Confidentialite
          </Link>
          <Link to="/contact" className="transition-colors hover:text-gold-soft">
            Contact
          </Link>
        </nav>
      </div>
    </footer>
  );
}
