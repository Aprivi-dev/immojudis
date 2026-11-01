/**
 * Pourquoi un lien partagé ne s'ouvre plus :
 * - `expired` : la date d'échéance du lien est passée ;
 * - `owner_plan_ended` : la personne qui l'a créé n'a plus l'offre qui permet de partager ses rapports
 *   (fin de l'essai gratuit, abonnement terminé). Le rapport n'est pas supprimé.
 */
export type SharedReportUnavailableReason = "expired" | "owner_plan_ended";

/**
 * Le lien existe mais ne s'ouvre plus : il a expiré, ou son propriétaire n'a plus l'accès aux
 * rapports (fin de l'essai gratuit, abonnement terminé). La page partagée l'explique au
 * destinataire au lieu d'un 404, en disant la vraie raison ; un lien inconnu ou invalide reste un 404.
 */
export class SharedReportUnavailableError extends Error {
  readonly reason: SharedReportUnavailableReason;

  constructor(reason: SharedReportUnavailableReason = "expired") {
    super("Rapport partagé introuvable ou expiré.");
    this.name = "SharedReportUnavailableError";
    this.reason = reason;
  }
}
