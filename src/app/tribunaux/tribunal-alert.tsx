"use client";

import Link from "next/link";
import { useId, useState } from "react";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import { Card, buttonClasses } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/use-auth";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { alertCreationLoginPath, alertCreationPath } from "@/lib/discovery-alerts";
import { LAUNCH_OFFER_SHORT_TEXT } from "@/lib/launch-offer";

export const TRIBUNAL_ALERT_TITLE = "Être prévenu des ventes de ce tribunal";
const DEPARTMENT_ALERT_TITLE = "Être prévenu des nouvelles ventes";

type Scope = "tribunal" | "department";

type Option = { scope: Scope; label: string; hint: string; criteria: Record<string, string> };

/**
 * La seule carte d'alerte de la page d'un tribunal (repasse design n° 28) : la personne choisit ce
 * que suit l'alerte, ce tribunal seulement ou tout son département, puis un seul bouton l'emmène
 * dans le parcours existant. Un visiteur passe par la connexion (motif « alerte ») et retrouve son
 * choix sur la page de confirmation (`/alertes/creer`) ; une personne connectée y va directement.
 * L'email récapitulatif y reste un choix explicite, jamais pré-coché.
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
  const { user, loading } = useAuth();
  const launchOffer = useLaunchOffer().active;
  const titleId = useId();
  const name = useId();
  const options: Option[] = [
    ...(tribunal
      ? [
          {
            scope: "tribunal" as const,
            label: "Ce tribunal seulement",
            hint: `Les nouvelles ventes référencées pour le ${lowerFirst(tribunal.longName)}.`,
            criteria: { tribunal: tribunal.searchName },
          },
        ]
      : []),
    ...(department
      ? [
          {
            scope: "department" as const,
            label: "Tout le département",
            hint: `Les nouvelles ventes référencées ${department.where}, tous tribunaux confondus.`,
            criteria: { department: department.code },
          },
        ]
      : []),
  ];
  const [scope, setScope] = useState<Scope>(options[0]?.scope ?? "tribunal");
  const selected = options.find((option) => option.scope === scope) ?? options[0];
  if (!selected) return null;
  const signedIn = Boolean(user) && !loading;

  return (
    <Card as="section" aria-labelledby={titleId} className="grid gap-3">
      <h2 id={titleId} className="flex items-center gap-2 font-display text-2xl font-semibold">
        <Bell className="size-5 shrink-0 text-gold-text" aria-hidden />
        {tribunal ? TRIBUNAL_ALERT_TITLE : DEPARTMENT_ALERT_TITLE}
      </h2>
      {options.length > 1 ? (
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-sm text-ink-soft">L’alerte porte sur :</legend>
          {options.map((option) => (
            <label key={option.scope} className="flex min-h-11 cursor-pointer items-start gap-3">
              <input
                type="radio"
                name={name}
                value={option.scope}
                checked={option.scope === selected.scope}
                onChange={() => setScope(option.scope)}
                className="mt-1 size-5 shrink-0 accent-brand-navy"
              />
              <span className="text-sm">
                <span className="font-semibold">{option.label}</span>
                <span className="block text-ink-soft">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="text-sm text-ink-soft">{selected.hint}</p>
      )}
      <div>
        <Link
          href={
            signedIn
              ? alertCreationPath(selected.criteria)
              : alertCreationLoginPath(selected.criteria)
          }
          className={buttonClasses({ variant: "primary" })}
        >
          Créer l’alerte
        </Link>
      </div>
      {!signedIn && launchOffer ? (
        <p data-testid="tribunal-alert-trial" className="text-sm font-medium">
          {LAUNCH_OFFER_SHORT_TEXT}
        </p>
      ) : null}
      <p className="text-xs text-ink-soft">
        {signedIn
          ? "Vous confirmez l’alerte à l’étape suivante ; l’email récapitulatif reste facultatif."
          : "Compte gratuit, sans carte bancaire. Vous retrouvez ce choix après la connexion ; l’email récapitulatif reste facultatif."}
      </p>
    </Card>
  );
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}
