import type { Metadata } from "next";
import { PHOTO_MIRROR_ISR_TIMEOUT_MS } from "@/lib/photo-mirror";
import { FIRST_PAGE_REVALIDATE_SECONDS } from "@/lib/public-catalogue.server";
import { validateSalesSearch } from "@/lib/search/search-url-state";
import { mustSeedStaticCatalogue, SALES_ISR_PAGES } from "@/lib/sales-isr";
import { renderSalesCatalogue, salesPageMetadata } from "../../sales-catalogue";

// Variante statique de `/sales?page=2` et `/sales?page=3` (voir `src/lib/sales-isr.ts`) : le proxy
// y réécrit ces deux adresses exactes, le visiteur et les robots continuent de voir `/sales?page=N`.
// Le HTML est le même pour tous (page N du catalogue public, visiteur déconnecté) ; il ne lit
// aucun cookie, aucun en-tête et aucun paramètre d'adresse : rien qui varie selon la personne ne
// peut donc être gardé par le cache partagé. Le navigateur s'occupe ensuite du compte, comme sur
// la page rendue à la demande.
//
// - `revalidate` : littéral, égal à FIRST_PAGE_REVALIDATE_SECONDS (un test le vérifie), comme la
//   première page : une annonce publiée apparaît au plus tard après 5 à 10 minutes.
// - `force-static` : `useSearchParams()` rend des paramètres vides côté serveur ; `staticQuery`
//   donne à `SalesPage` l'adresse `page=N` que cette variante représente.
// - `dynamicParams = false` : seules les pages de `SALES_ISR_PAGES` existent ; toute autre valeur
//   est un 404 (le proxy n'y réécrit jamais).
// - Panne de base : comme pour la première page, une régénération qui ne peut pas lire le
//   catalogue lève l'erreur (`requireServerSeed`) au lieu de garder 5 minutes une page sans
//   annonces ; au build, la page reste rendue sans liste.
// - Pas de `robots` ici : la variante demandée en direct reçoit `X-Robots-Tag: noindex` du proxy.
export const revalidate = 300;
export const dynamic = "force-static";
export const dynamicParams = false;

type PageProps = { params: Promise<{ page: string }> };

export function generateStaticParams() {
  return SALES_ISR_PAGES.map((page) => ({ page: String(page) }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { page } = await params;
  return salesPageMetadata(validateSalesSearch({ page }));
}

export default async function Page({ params }: PageProps) {
  const { page } = await params;
  // Les lignes comptent comme fraîches pendant toute la vie de la page (5 minutes, puis le
  // `staleTime` du navigateur) : une page servie plus tard que cela relance la recherche.
  return renderSalesCatalogue(validateSalesSearch({ page }), {
    dataUpdatedAt: Date.now() + FIRST_PAGE_REVALIDATE_SECONDS * 1000,
    requireServerSeed: mustSeedStaticCatalogue(),
    // Régénération en arrière-plan : on peut attendre les copies de photos plus longtemps.
    photoMirrorTimeoutMs: PHOTO_MIRROR_ISR_TIMEOUT_MS,
    staticQuery: `page=${page}`,
  });
}
