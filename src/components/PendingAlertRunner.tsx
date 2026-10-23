"use client";

import { useEffect, useState, type ComponentType } from "react";
import { useAuth } from "@/hooks/use-auth";
import { peekPendingAlert } from "@/lib/pending-alert";

/**
 * Crée l'alerte qu'un visiteur avait demandée avant d'avoir un compte (`savePendingAlert`), dès
 * qu'il est connecté, sur la page où il revient après l'inscription ou la confirmation de son
 * adresse. Ne coûte presque rien aux autres pages : le créateur (`PendingAlertCreator`, qui tire
 * le crochet de création et ses requêtes) n'est chargé que si une demande est en attente.
 */
export function PendingAlertRunner() {
  const { user, loading } = useAuth();
  const [Creator, setCreator] = useState<ComponentType | null>(null);
  const signedIn = Boolean(user) && !loading;

  useEffect(() => {
    if (!signedIn || Creator || !peekPendingAlert()) return;
    let cancelled = false;
    import("@/components/PendingAlertCreator").then(
      (module) => {
        if (!cancelled) setCreator(() => module.PendingAlertCreator);
      },
      (error: unknown) => {
        console.error("[alerte] Chargement de la création en attente en échec", String(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [signedIn, Creator]);

  return Creator ? <Creator /> : null;
}
