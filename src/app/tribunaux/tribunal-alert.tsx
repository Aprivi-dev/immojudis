import { useId } from "react";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import { Card, buttonClasses } from "@/components/ui/primitives";
import { alertCreationLoginPath, alertCreationPath } from "@/lib/discovery-alerts";
import { TribunalAlertChoice, type TribunalAlertOption } from "./tribunal-alert-choice";

export const TRIBUNAL_ALERT_TITLE = "Être prévenu des ventes de ce tribunal";
const DEPARTMENT_ALERT_TITLE = "Être prévenu des nouvelles ventes";

function option(
  label: string,
  hint: string,
  criteria: Record<string, string>,
): TribunalAlertOption {
  return {
    label,
    hint,
    visitorHref: alertCreationLoginPath(criteria),
    memberHref: alertCreationPath(criteria),
  };
}

/**
 * La seule carte d'alerte de la page d'un tribunal (repasse design n° 28) : la personne choisit ce
 * que suit l'alerte, ce tribunal seulement ou tout son département, puis un seul bouton l'emmène
 * dans le parcours existant. Un visiteur passe par la connexion (motif « alerte ») et retrouve son
 * choix sur la page de confirmation (`/alertes/creer`) ; une personne connectée y va directement.
 * L'email récapitulatif y reste un choix explicite, jamais pré-coché.
 *
 * Rendue par le serveur ; seuls le choix et le bouton sont interactifs (`TribunalAlertChoice`).
 */
export function TribunalAlert({
  tribunal,
  department,
}: {
  /** Nom de recherche du tribunal (filtre du catalogue) et nom long ; `null` sans nom lisible. */
  tribunal: { searchName: string; longName: string } | null;
  /** Code du département et sa préposition (« en Gironde ») ; `null` s'il n'est pas connu. */
  department: { code: string; where: string } | null;
}) {
  const titleId = useId();
  const options = [
    ...(tribunal
      ? [
          option(
            "Ce tribunal seulement",
            `Les nouvelles ventes référencées pour le ${lowerFirst(tribunal.longName)}.`,
            { tribunal: tribunal.searchName },
          ),
        ]
      : []),
    ...(department
      ? [
          option(
            "Tout le département",
            `Les nouvelles ventes référencées ${department.where}, tous tribunaux confondus.`,
            { department: department.code },
          ),
        ]
      : []),
  ];
  if (!options.length) return null;

  return (
    <Card as="section" aria-labelledby={titleId} className="grid gap-3">
      <h2 id={titleId} className="flex items-center gap-2 font-display text-2xl font-semibold">
        <Bell className="size-5 shrink-0 text-gold-text" aria-hidden />
        {tribunal ? TRIBUNAL_ALERT_TITLE : DEPARTMENT_ALERT_TITLE}
      </h2>
      <TribunalAlertChoice
        options={options}
        buttonClassName={buttonClasses({ variant: "primary" })}
      />
    </Card>
  );
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}
