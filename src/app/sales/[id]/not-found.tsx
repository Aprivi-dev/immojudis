import { SaleNotFoundComponent } from "@/components/SaleDetailFallbacks";

/**
 * Identifiant de vente inconnu (`notFound()` dans `page.tsx`). Propre au segment : le `h1`
 * « Annonce introuvable » suit le titre de l'onglet, au lieu de « Page introuvable » de la page
 * 404 générale ; et, rendue sous la frontière de `loading.tsx`, l'erreur ne remonte plus au-dessus
 * d'elle (erreur React n° 419 au chargement). Repasse design n° 46.
 */
export default function SaleNotFound() {
  return <SaleNotFoundComponent />;
}
