import { PHOTO_MIRROR_ISR_TIMEOUT_MS } from "@/lib/photo-mirror";
import { FIRST_PAGE_REVALIDATE_SECONDS } from "@/lib/public-catalogue.server";
import { validateSalesSearch } from "@/lib/search/search-url-state";
import { mustSeedStaticCatalogue } from "@/lib/sales-isr";
import { renderSalesCatalogue, salesMetadata } from "../sales-catalogue";

// Variante statique de l'adresse nue `/sales` (voir `src/lib/sales-isr.ts`) : `src/proxy.ts`
// y réécrit toute requête sans paramètre, le visiteur et les robots continuent de voir `/sales`.
// Le HTML est le même pour tous (première page du catalogue public, visiteur déconnecté) ; le
// navigateur s'occupe ensuite du compte, comme sur la page rendue à la demande.
//
// - `revalidate` : Next.js veut un littéral ; il doit égaler FIRST_PAGE_REVALIDATE_SECONDS
//   (un test le vérifie). Le cache de la première page dure aussi 5 minutes : une annonce publiée
//   apparaît au plus tard après 5 à 10 minutes.
// - `force-static` : `useSearchParams()` rend alors des paramètres vides au lieu de renvoyer la
//   page au navigateur derrière `loading.tsx` ; c'est exact, l'adresse n'en porte aucun. Il
//   écarte aussi `connection()` du layout racine : le proxy ne réécrit donc plus vers cette page
//   dès que la CSP à nonce est servie (`strictCspEnabled`), qui exige un rendu à la demande.
// - Panne de base : en production, hors `next build`, une régénération qui ne peut pas lire le
//   catalogue lève l'erreur (`requireServerSeed`) : Next.js garde alors la dernière bonne page au
//   lieu de mettre en cache 5 minutes une page sans annonces. Au build, la page reste rendue sans
//   liste (pas de base dans l'environnement factice de la CI). Voir `mustSeedStaticCatalogue`.
// - Pas de `robots` ici : l'adresse publique est `/sales`, qui doit rester indexable ; la variante
//   interne reçoit `X-Robots-Tag: noindex` du proxy quand on la demande directement.
export const revalidate = 300;
export const dynamic = "force-static";
export const metadata = salesMetadata;

export default async function Page() {
  // Les lignes comptent comme fraîches pendant toute la vie de la page (5 minutes, puis le
  // `staleTime` du navigateur) : une page servie plus tard que cela relance la recherche.
  return renderSalesCatalogue(validateSalesSearch({}), {
    dataUpdatedAt: Date.now() + FIRST_PAGE_REVALIDATE_SECONDS * 1000,
    requireServerSeed: mustSeedStaticCatalogue(),
    // Régénération en arrière-plan : on peut attendre les copies de photos plus longtemps que pour un
    // visiteur (la page garde ensuite cinq minutes les photos reçues).
    photoMirrorTimeoutMs: PHOTO_MIRROR_ISR_TIMEOUT_MS,
  });
}
