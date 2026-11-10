/** Libellés et règles partagés par l'éditeur de message (À contacter) et la liste des envois. */

/** Un brouillon ou un échec se reprend et se modifie ; tout autre statut s'ouvre en lecture seule. */
export function isMissionEditable(status: string): boolean {
  return status === "draft" || status === "failed";
}

export function missionStatusLabel(status: string): string {
  return (
    {
      draft: "Brouillon",
      subscribed: "Rattachée au dossier",
      approved: "Validée",
      sending: "Envoi en cours",
      sent: "Envoyée",
      replied: "Réponse reçue",
      review: "À vérifier",
      completed: "Terminée",
      failed: "Échec",
      cancelled: "Annulée",
    }[status] ?? status
  );
}
