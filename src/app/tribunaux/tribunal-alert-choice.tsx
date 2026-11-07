"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { useAuth } from "@/hooks/use-auth";

/** Un choix de la carte d'alerte : ses textes et ses deux adresses, calculés par le serveur. */
export type TribunalAlertOption = {
  label: string;
  hint: string;
  /** Visiteur : la connexion (motif « alerte »), qui ramène à la confirmation. */
  visitorHref: string;
  /** Personne connectée : la page de confirmation de l'alerte. */
  memberHref: string;
};

/**
 * La partie interactive de la carte d'alerte d'un tribunal : le choix et l'unique bouton. Tout le
 * reste (carte, titre, adresses, classes) vient du serveur : ce composant n'importe que `useAuth`,
 * pour ne pas recopier dans les fichiers JavaScript de la page le parcours d'alerte complet.
 */
export function TribunalAlertChoice({
  options,
  buttonClassName,
}: {
  options: readonly TribunalAlertOption[];
  buttonClassName: string;
}) {
  const { user, loading } = useAuth();
  const name = useId();
  const [index, setIndex] = useState(0);
  const selected = options[index] ?? options[0];
  if (!selected) return null;
  const signedIn = Boolean(user) && !loading;

  return (
    <>
      {options.length > 1 ? (
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-sm text-ink-soft">L’alerte porte sur :</legend>
          {options.map((option, optionIndex) => (
            <label key={option.label} className="flex min-h-11 cursor-pointer items-start gap-3">
              <input
                type="radio"
                name={name}
                checked={option === selected}
                onChange={() => setIndex(optionIndex)}
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
          href={signedIn ? selected.memberHref : selected.visitorHref}
          className={buttonClassName}
        >
          Créer l’alerte
        </Link>
      </div>
      <p className="text-xs text-ink-soft">
        {signedIn
          ? "Vous confirmez l’alerte à l’étape suivante ; l’email récapitulatif reste facultatif."
          : "Compte gratuit, sans carte bancaire. Vous retrouvez ce choix après la connexion ; l’email récapitulatif reste facultatif."}
      </p>
    </>
  );
}
