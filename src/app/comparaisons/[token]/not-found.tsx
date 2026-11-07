import Link from "next/link";
import { StatusPage } from "@/components/StatusPage";
import { buttonClasses } from "@/components/ui/primitives";

/**
 * Lien de comparaison partagée qui ne mène plus à rien (repasse design n° 29) : expiré, désactivé ou
 * remplacé par son auteur, ou dont aucune vente n'est encore en ligne. La page répond toujours 404,
 * mais avec ce message plutôt que la page introuvable générique.
 */
export default function SharedComparisonNotFound() {
  return (
    <StatusPage
      eyebrow="Comparaison partagée"
      title="Ce lien de comparaison n’est plus valable"
      description="Un lien de partage n’est valable que pour une durée limitée. Il a peut-être expiré, été désactivé ou remplacé par la personne qui l’a créé, ou les ventes qu’il comparait ne sont plus en ligne. Demandez-lui un nouveau lien, ou parcourez les ventes à venir."
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
    />
  );
}
