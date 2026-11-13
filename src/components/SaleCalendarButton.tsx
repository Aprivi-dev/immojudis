"use client";

import { useState } from "react";
import CalendarPlus from "lucide-react/dist/esm/icons/calendar-plus.js";
import { Button } from "@/components/ui/primitives";
import { apiDownload, apiFetch } from "@/lib/client-api-core";
import { downloadBlob } from "@/lib/download-blob";
import { userMessage } from "@/lib/user-messages";

const FALLBACK_FILENAME = "immojudis-audience.ics";

/**
 * Mesure par compte de l'export (point 65). Le fichier est public et mis en cache : seul le
 * navigateur d'une personne connectée peut dire qui l'a téléchargé. Sans session, `apiFetch`
 * répond « Connexion requise. » sans rien charger ni envoyer. La mesure ne gêne jamais le
 * téléchargement.
 */
async function reportExport(saleId: string): Promise<void> {
  try {
    await apiFetch(`/api/sales/${encodeURIComponent(saleId)}/calendar/exported`, {
      method: "POST",
    });
  } catch {
    // Sans compte ou hors ligne : rien à mesurer.
  }
}

/**
 * « Ajouter à mon agenda » : downloads the `.ics` file of the hearing. No account needed: the
 * route answers the same way for everyone. The server alone decides whether the date is reliable
 * enough to be exported; a refusal is shown here in words, not as a broken download. A signed-in
 * account also reports the download, so that it is measured per account (`reportExport`).
 */
export function SaleCalendarButton({ saleId }: { saleId: string }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function download() {
    setPending(true);
    setMessage(null);
    try {
      const { blob, filename } = await apiDownload(
        `/api/sales/${encodeURIComponent(saleId)}/calendar`,
        { anonymous: true },
        FALLBACK_FILENAME,
      );
      downloadBlob(blob, filename);
      void reportExport(saleId);
    } catch (error) {
      setMessage(userMessage(error, "L’export vers l’agenda est indisponible pour le moment."));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-2">
      <Button
        variant="secondary"
        onClick={() => void download()}
        disabled={pending}
        aria-busy={pending}
      >
        <CalendarPlus className="size-4" aria-hidden />
        {pending ? "Préparation…" : "Ajouter à mon agenda"}
      </Button>
      <p className="mt-1 text-xs text-ink-soft">
        Date issue de l’annonce, à vérifier auprès de l’avocat poursuivant. Le fichier ne se met pas
        à jour si la date change.
      </p>
      {message ? (
        <p role="alert" className="mt-1 text-xs text-danger">
          {message}
        </p>
      ) : null}
    </div>
  );
}
