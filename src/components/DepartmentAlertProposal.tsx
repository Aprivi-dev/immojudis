"use client";

import Link from "next/link";
import { useId, useState } from "react";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import { FEES_SIMULATOR_DEPARTMENTS } from "@/components/fees-simulator/departments";
import { SectorAlertForm } from "@/components/SectorAlertFormLazy";
import { Button, Card, buttonClasses } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/use-auth";
import { alertCreationLoginPath } from "@/lib/discovery-alerts";

// Même aspect que les champs du simulateur ; recopié ici car `fields.tsx` importe le moteur de frais
// (`profitability`), trop lourd pour le JavaScript initial de l'annonce exemple.
const FIELD_CLASSES =
  "min-h-11 w-full min-w-0 rounded-lg border border-line bg-white px-3 text-base focus-visible:border-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft";

export const DEPARTMENT_ALERT_LABEL = "Être prévenu des ventes de mon département";

/**
 * Suite proposée sous les outils gratuits (simulateur, annonce exemple, fin d'article) : une alerte
 * sur le département de la personne, en plus de la simple création de compte. Elle choisit son
 * département ; un visiteur passe par la connexion (motif « alerte ») et confirme l'alerte ensuite,
 * une personne connectée la crée ici même. Rien n'est envoyé par email sans la case dédiée, jamais
 * pré-cochée (`SectorAlertForm`).
 */
export function DepartmentAlertProposal({ className }: { className?: string }) {
  const selectId = useId();
  const hintId = useId();
  const { user, loading } = useAuth();
  const [department, setDepartment] = useState("");
  const connected = Boolean(user) && !loading;

  return (
    <section aria-labelledby={`${selectId}-title`} className={className}>
      <div className="grid gap-3">
        <Card className="grid gap-3">
          <h2
            id={`${selectId}-title`}
            className="flex items-center gap-2 font-display text-2xl font-semibold"
          >
            <Bell className="size-5 text-gold-text" aria-hidden />
            {DEPARTMENT_ALERT_LABEL}
          </h2>
          <p className="max-w-2xl text-sm text-ink-soft">
            Choisissez votre département : l’alerte vous prévient, dans votre compte, des nouvelles
            ventes référencées dans ce département. L’email récapitulatif est facultatif : il n’est
            activé que si vous cochez la case prévue à cet effet (décochée par défaut) ; il est
            hebdomadaire avec l’offre Découverte, quotidien avec l’offre Analyse, essai gratuit
            compris. Si vous l’avez déjà activé dans votre compte, il s’applique aussi à cette
            alerte.
          </p>
          <div className="grid max-w-sm gap-1">
            <label htmlFor={selectId} className="text-sm font-semibold">
              Département
            </label>
            <select
              id={selectId}
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
              className={FIELD_CLASSES}
            >
              <option value="">Choisir un département</option>
              {FEES_SIMULATOR_DEPARTMENTS.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.code} – {item.name}
                </option>
              ))}
            </select>
          </div>
          {connected || loading ? null : (
            <>
              <div>
                {department ? (
                  <Link
                    href={alertCreationLoginPath({ department })}
                    className={buttonClasses({ variant: "primary" })}
                  >
                    {DEPARTMENT_ALERT_LABEL}
                  </Link>
                ) : (
                  <Button variant="primary" disabled aria-describedby={hintId}>
                    {DEPARTMENT_ALERT_LABEL}
                  </Button>
                )}
              </div>
              <p id={hintId} className="text-xs text-ink-soft">
                {department
                  ? "Compte gratuit, sans carte bancaire. Après la connexion, vous confirmez l’alerte et choisissez si vous voulez aussi l’email récapitulatif : la case est décochée par défaut."
                  : "Choisissez d’abord un département."}
              </p>
            </>
          )}
        </Card>
        {connected && department ? (
          <SectorAlertForm
            key={department}
            criteria={{ department }}
            title="Votre alerte pour ce département"
            actionLabel="Créer l’alerte"
          />
        ) : null}
      </div>
    </section>
  );
}
