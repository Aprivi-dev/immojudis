import { formatDate } from "@/lib/format";

/**
 * Ce que la personne doit savoir quand elle crée le lien : sa durée de vie (l'échéance, ou la fin
 * de son accès aux rapports si elle vient avant : fin de l'essai gratuit) et ce que voit le
 * destinataire (le titre du rapport et les choix de scénario).
 */
export function reportShareNotice(expiresAt: string | null | undefined): string {
  const lifetime = expiresAt
    ? `Le lien fonctionne jusqu’au ${formatDate(expiresAt)}, ou jusqu’à la fin de votre accès aux rapports si elle vient avant.`
    : "Le lien fonctionne tant que vous gardez l’accès aux rapports.";
  return `${lifetime} Toute personne qui a le lien voit le titre du rapport et vos choix de scénario.`;
}
