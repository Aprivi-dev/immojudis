"use client";

import { useState } from "react";
import { toast } from "@/lib/toast";

/**
 * « Partager » de la fiche publique : le partage du système quand il existe, sinon l'adresse copiée.
 * Le lien partagé est l'adresse de la fiche, sans ancre ni page d'origine (`from`). Même comportement
 * que le partage de la fiche des comptes.
 */
export function SalePublicShareButton({ title, className }: { title: string; className: string }) {
  const [sharing, setSharing] = useState(false);
  async function share() {
    setSharing(true);
    try {
      const url = new URL(window.location.href);
      url.hash = "";
      url.searchParams.delete("from");
      if (navigator.share) {
        await navigator.share({ title, url: url.href });
      } else {
        await navigator.clipboard.writeText(url.href);
        toast.success("Lien de l’annonce copié");
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        toast.error("Partage indisponible. Vous pouvez copier l’adresse de cette page.");
      }
    } finally {
      setSharing(false);
    }
  }
  return (
    <button
      type="button"
      className={className}
      aria-label="Partager cette annonce"
      onClick={() => void share()}
      disabled={sharing}
    >
      Partager
    </button>
  );
}
