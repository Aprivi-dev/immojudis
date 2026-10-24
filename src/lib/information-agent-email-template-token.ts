import type { InformationAgentEmailVariable } from "@/lib/information-agent-email-template";

/**
 * Jeton d'une variable du modèle d'email (`{{clé}}`). À part du module du modèle : l'éditeur de
 * l'administration n'a besoin que de cette fonction, et le module du modèle embarque les schémas
 * zod de validation, que le navigateur n'a pas à télécharger.
 */
export function templateVariableToken(key: InformationAgentEmailVariable): string {
  return `{{${key}}}`;
}
