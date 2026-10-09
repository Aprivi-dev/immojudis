import type { LegalPublisher } from "@/lib/legal-documents";

/**
 * Withdrawal information and the model form of annex R221-1 of the Code de la
 * consommation, written into the contract confirmation e-mail so the customer
 * holds them on a durable medium (art. L221-5).
 */
export function withdrawalInformationLines({
  publisher,
  rightsUrl,
  orderedOn,
}: {
  publisher: Pick<LegalPublisher, "entityName" | "address" | "contactEmail">;
  rightsUrl: string;
  orderedOn: string;
}): string[] {
  const entity = publisher.entityName ?? "Immojudis";
  const address = publisher.address ?? "adresse indiquée dans les mentions légales";
  const email = publisher.contactEmail ?? "adresse de contact indiquée dans les mentions légales";
  return [
    "Droit de rétractation",
    "Vous disposez de 14 jours à compter de la souscription pour vous rétracter, sans avoir à motiver votre décision.",
    "Si vous avez demandé l'exécution immédiate du service, vous devez payer un montant proportionnel à ce qui vous a été fourni jusqu'à la communication de votre décision de rétractation.",
    `Pour vous rétracter, utilisez le formulaire en ligne (${rightsUrl}) ou renvoyez le formulaire ci-dessous par email à ${email}.`,
    "",
    "Modèle de formulaire de rétractation (à compléter et renvoyer uniquement si vous souhaitez vous rétracter)",
    `À l'attention de ${entity}, ${address}, ${email} :`,
    "Je vous notifie par la présente ma rétractation du contrat portant sur la prestation de services ci-dessous :",
    "Prestation : abonnement Immojudis Analyse",
    `Commandé le : ${orderedOn}`,
    "Nom du consommateur : ",
    "Adresse du consommateur : ",
    "Date : ",
  ];
}
