/**
 * Le lien existe mais ne s'ouvre plus : il a expiré, ou son propriétaire n'a plus l'accès aux
 * rapports (fin de l'essai gratuit, abonnement terminé). La page partagée l'explique au
 * destinataire au lieu d'un 404 ; un lien inconnu ou invalide reste un 404.
 */
export class SharedReportUnavailableError extends Error {
  constructor() {
    super("Rapport partagé introuvable ou expiré.");
    this.name = "SharedReportUnavailableError";
  }
}
