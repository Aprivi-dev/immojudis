"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card } from "@/components/ui/primitives";
import { authHeaders, readJson } from "@/lib/client-api-core";
import { lawyerQuestionsText, type LawyerQuestionsResponse } from "@/lib/lawyer-questions-text";
import type { SaleAccessMode } from "@/lib/query-keys";

const HEADING = "Mes questions pour l’avocat";

/**
 * À l'impression, seule la liste reste : tout élément qui ne la contient pas et n'est pas dedans est
 * masqué (`display: none`, donc sans pages blanches).
 */
const PRINT_ONLY_THE_LIST =
  "@media print{body *:not(#questions-avocat):not(#questions-avocat *):not(:has(#questions-avocat)){display:none!important}}";

async function fetchLawyerQuestions(saleId: string): Promise<LawyerQuestionsResponse> {
  const response = await fetch(`/api/sales/${encodeURIComponent(saleId)}/lawyer-questions`, {
    headers: await authHeaders(),
    signal: AbortSignal.timeout(15_000),
  });
  return readJson<LawyerQuestionsResponse>(response);
}

/**
 * « Mes questions pour l'avocat » (n° 92) : les points que la fiche laisse ouverts, formulés comme
 * des questions à poser à son avocat avant d'enchérir. Le repérage est fait par le serveur
 * (`/api/sales/[id]/lawyer-questions`, qui reprend les questions de l'agent d'information) : ce
 * composant ne fait que l'afficher. Copiable et imprimable ; aucun envoi, rien n'est enregistré.
 * Rien n'est affiché quand la lecture est refusée ou échoue.
 */
export function LawyerQuestions({
  saleId,
  access,
  userKey,
}: {
  saleId: string;
  access: SaleAccessMode;
  userKey: string;
}) {
  const query = useQuery({
    queryKey: ["lawyer-questions", saleId, access, userKey] as const,
    queryFn: () => fetchLawyerQuestions(saleId),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const [status, setStatus] = useState("");
  const questions = query.data?.questions;
  if (!questions) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(lawyerQuestionsText(questions ?? [], HEADING));
      setStatus("Liste copiée.");
    } catch {
      setStatus("Copie impossible : sélectionnez le texte de la liste.");
    }
  }

  return (
    <Card
      as="section"
      id="questions-avocat"
      aria-labelledby="lawyer-questions-title"
      className="mt-4"
    >
      <style>{PRINT_ONLY_THE_LIST}</style>
      <h3 id="lawyer-questions-title" className="font-display text-xl text-brand-navy">
        {HEADING}
      </h3>
      <p className="mt-1 text-sm leading-relaxed text-ink-soft">
        Les points que la fiche laisse ouverts, à poser à votre avocat avant d’enchérir. Rien n’est
        envoyé : la liste reste sur cet écran.
      </p>
      {questions.length ? (
        <>
          <ol className="mt-3 list-decimal space-y-3 pl-5 text-sm leading-relaxed">
            {questions.map((entry) => (
              <li key={entry.key}>
                <span className="font-semibold">{entry.label} : </span>
                {entry.question}
                <span className="block text-xs text-ink-soft">Dans la fiche : {entry.reason}</span>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex flex-wrap items-center gap-2 print:hidden">
            <Button variant="secondary" size="sm" onClick={() => void copy()}>
              Copier la liste
            </Button>
            <Button variant="secondary" size="sm" onClick={() => window.print()}>
              Imprimer
            </Button>
            <span role="status" className="text-xs font-semibold text-ink-soft">
              {status}
            </span>
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm leading-relaxed">
          La fiche ne laisse aucun point ouvert que nous sachions repérer. Cela ne remplace pas vos
          propres questions à l’avocat.
        </p>
      )}
    </Card>
  );
}
