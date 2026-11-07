"use client";

import { useState } from "react";
import CalendarPlus from "lucide-react/dist/esm/icons/calendar-plus.js";
import { Button } from "@/components/ui/primitives";
import { authHeaders } from "@/lib/client-api-core";
import { userMessage } from "@/lib/user-messages";

const FALLBACK_FILENAME = "immojudis-audience.ics";

function filenameFrom(response: Response): string {
  const header = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"\\/]+\.ics)"/i.exec(header);
  return match?.[1] ?? FALLBACK_FILENAME;
}

/**
 * Mesure par compte de l'export (point 65). Le fichier est public et mis en cache : seul le
 * navigateur d'une personne connectée peut dire qui l'a téléchargé. Sans session, `authHeaders`
 * répond « Connexion requise. » sans rien charger ni envoyer. La mesure ne gêne jamais le
 * téléchargement.
 */
async function reportExport(saleId: string): Promise<void> {
  try {
    await fetch(`/api/sales/${encodeURIComponent(saleId)}/calendar/exported`, {
      method: "POST",
      headers: await authHeaders(),
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
      const response = await fetch(`/api/sales/${encodeURIComponent(saleId)}/calendar`);
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw Object.assign(new Error(payload?.error ?? ""), { status: response.status });
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filenameFrom(response);
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
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
        <p role="alert" className="mt-1 text-xs text-red-700">
          {message}
        </p>
      ) : null}
    </div>
  );
}
