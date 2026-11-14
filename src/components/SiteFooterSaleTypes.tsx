import Link from "next/link";
import { SALE_LANDING_PAGES, visibleSaleLandingKeys } from "@/lib/sale-landing-pages";

/**
 * Groupe « Ventes par type » du pied de page : les pages par type de bien ou de vente proposées
 * (`visibleSaleLandingKeys`), dans l'ordre du registre. Composant serveur, que le layout passe à
 * `SiteFooter` (composant client) : ces liens arrivent déjà rendus et n'ajoutent rien au JavaScript
 * initial de chaque page. Même présentation que les autres groupes du pied de page (un test compare
 * leurs classes).
 */
export function SiteFooterSaleTypes() {
  return (
    <nav aria-label="Ventes par type" className="border-t border-border pt-5">
      <p className="mb-2 font-semibold text-foreground">Ventes par type</p>
      <ul className="flex flex-wrap gap-x-5">
        {visibleSaleLandingKeys().map((key) => (
          <li key={key}>
            <Link
              href={SALE_LANDING_PAGES[key].path}
              prefetch={false}
              className="inline-flex min-h-11 items-center hover:text-foreground hover:underline"
            >
              {SALE_LANDING_PAGES[key].label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
