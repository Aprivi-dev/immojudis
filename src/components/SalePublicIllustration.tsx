import { PropertyIllustration, illustrationKind } from "@/components/PropertyIllustration";

/**
 * Dessin du type de bien de la galerie publique, quand l'annonce n'a pas de photo. Module à part :
 * chargé seulement pour ces fiches (`SalePublicPreview`), rendu par le serveur.
 */
export function SalePublicIllustration({ propertyType }: { propertyType: string | null }) {
  return <PropertyIllustration kind={illustrationKind(propertyType)} />;
}
