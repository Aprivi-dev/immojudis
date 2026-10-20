"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import Circle from "lucide-react/dist/esm/icons/circle.js";
import CircleCheck from "lucide-react/dist/esm/icons/circle-check.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { SaleRemindersToggle } from "@/components/SaleRemindersToggle";
import { Card } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/use-auth";
import { getSupabase } from "@/integrations/supabase/lazy";
import { fetchNotificationPreferences } from "@/lib/client-api";
import { saleDetailPath } from "@/lib/navigation";
import { queryKeys } from "@/lib/query-keys";
import {
  START_FAVORITES_LIMIT,
  readStartCardClosed,
  startComplete,
  startProgress,
  startSteps,
  writeStartCardClosed,
} from "@/lib/start-checklist";

function StepMark({ done }: { done: boolean }) {
  return (
    <>
      {done ? (
        <CircleCheck className="mt-0.5 size-5 shrink-0 text-emerald-700" aria-hidden />
      ) : (
        <Circle className="mt-0.5 size-5 shrink-0 text-ink-soft" aria-hidden />
      )}
      <span className="sr-only">{done ? "Fait : " : "À faire : "}</span>
    </>
  );
}

/**
 * « Mon démarrage » : trois lignes cochables pour un compte connecté, sur `/sales` et `/favoris`,
 * tant qu'elles ne sont pas toutes faites et que la carte n'a pas été fermée. Tout se déduit des
 * données existantes (favoris, « Mon dossier », consentement aux rappels d'audience) : aucune table
 * en plus. La fermeture est mémorisée par compte dans le navigateur. Rien ne s'affiche tant que les
 * lectures ne sont pas revenues, et rien en cas d'échec : une aide qui se trompe vaut moins que pas
 * d'aide.
 */
export function MonDemarrage({ className = "" }: { className?: string }) {
  const { user, loading } = useAuth();
  const userId = user?.id ?? null;
  // Fermeture lue dans le navigateur après l'affichage : tant qu'elle n'est pas lue, la carte reste cachée.
  const [stored, setStored] = useState<{ userId: string | null; closed: boolean }>({
    userId: null,
    closed: false,
  });
  useEffect(() => {
    if (userId) setStored({ userId, closed: readStartCardClosed(userId) });
  }, [userId]);
  const closed = stored.userId !== userId || stored.closed;
  const active = Boolean(userId) && !loading && !closed;

  const favoritesQuery = useQuery({
    queryKey: queryKeys.accountStart(userId),
    queryFn: async () => {
      const { data, error } = await (await getSupabase())
        .from("user_favorites")
        .select("sale_id,personal_status,bid_ceiling_eur")
        .eq("user_id", userId!)
        .order("created_at", { ascending: false })
        .limit(START_FAVORITES_LIMIT);
      if (error) throw error;
      return startProgress(data);
    },
    enabled: active,
    // Un dossier rempli sur une fiche doit se voir au retour sur la liste : relue à chaque affichage.
    staleTime: 0,
    retry: false,
  });
  const preferencesQuery = useQuery({
    queryKey: queryKeys.notificationPreferences(userId ?? "anonymous"),
    queryFn: fetchNotificationPreferences,
    enabled: active,
    staleTime: 60_000,
    retry: false,
  });

  const progress = favoritesQuery.data;
  const preferencesSettled = preferencesQuery.isSuccess || preferencesQuery.isError;
  if (!active || !userId || !progress || !preferencesSettled) return null;

  const steps = startSteps(progress, {
    // Sans réponse des préférences, la ligne du rappel n'est pas proposée.
    available: preferencesQuery.data?.saleRemindersAvailable === true,
    enabled: preferencesQuery.data?.preferences.saleRemindersEnabled === true,
  });
  if (startComplete(steps)) return null;

  const status = (id: "follow" | "dossier" | "reminder") =>
    steps.find((step) => step.id === id)?.done ?? false;

  return (
    <Card
      as="section"
      aria-labelledby="mon-demarrage-title"
      data-testid="mon-demarrage"
      className={className}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="mon-demarrage-title" className="font-display text-xl text-brand-navy">
            Mon démarrage
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            Trois gestes pour tirer parti de votre compte ; la carte disparaît quand ils sont faits.
          </p>
        </div>
        <button
          type="button"
          aria-label="Fermer « Mon démarrage »"
          onClick={() => {
            writeStartCardClosed(userId);
            setStored({ userId, closed: true });
          }}
          className="-m-2 grid size-11 shrink-0 place-items-center rounded-md text-ink-soft hover:text-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
        >
          <X className="size-5" aria-hidden />
        </button>
      </div>

      <ul className="mt-3 grid gap-3">
        <li className="flex items-start gap-3">
          <StepMark done={status("follow")} />
          <div className="text-sm">
            <p className="font-semibold text-brand-navy">Suivre une vente</p>
            {status("follow") ? null : (
              <p className="text-ink-soft">
                Touchez le cœur sur une annonce du catalogue : elle rejoint vos favoris, sur tous
                vos appareils.
              </p>
            )}
          </div>
        </li>

        <li className="flex items-start gap-3">
          <StepMark done={status("dossier")} />
          <div className="text-sm">
            <p className="font-semibold text-brand-navy">Noter mon statut ou mon enchère plafond</p>
            {status("dossier") ? null : (
              <>
                <p className="text-ink-soft">
                  {progress.followed
                    ? "Dans « Mon dossier », sur la fiche d’une vente suivie. L’enchère plafond n’existe que pour les ventes au tribunal ; le statut vaut pour toute vente suivie."
                    : "Suivez d’abord une vente : « Mon dossier » s’ouvre sur sa fiche. L’enchère plafond n’existe que pour les ventes au tribunal ; le statut vaut pour toute vente suivie."}
                </p>
                {progress.followed && progress.dossierSaleId ? (
                  <Link
                    href={`${saleDetailPath(progress.dossierSaleId)}#mon-dossier`}
                    className="mt-1 inline-flex min-h-11 items-center font-semibold text-gold-text underline underline-offset-4"
                  >
                    Ouvrir « Mon dossier »
                  </Link>
                ) : null}
              </>
            )}
          </div>
        </li>

        {steps.some((step) => step.id === "reminder") ? (
          <li className="flex items-start gap-3">
            <StepMark done={status("reminder")} />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-semibold text-brand-navy">Recevoir un rappel d’audience</p>
              <SaleRemindersToggle
                userId={userId}
                className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3 text-sm"
              />
            </div>
          </li>
        ) : null}
      </ul>
    </Card>
  );
}
