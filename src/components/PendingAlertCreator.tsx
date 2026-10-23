"use client";

import { useEffect, useRef, useState } from "react";
import { useCreateAlert } from "@/hooks/use-create-alert";
import { takePendingAlert } from "@/lib/pending-alert";

/**
 * Crée l'alerte en attente une fois les droits du compte lus (`ready`), puis ne fait plus rien.
 * Le résultat est annoncé par les notifications du crochet (« Recherche enregistrée »,
 * ou la raison du refus). La demande est effacée avant la création : elle ne se rejoue pas.
 */
export function PendingAlertCreator() {
  const { createAlertFromSearch, ready } = useCreateAlert({ returnTo: null });
  const started = useRef(false);
  const [, setDone] = useState(false);

  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    const pending = takePendingAlert();
    if (!pending) return;
    void createAlertFromSearch(pending.search, pending.options).finally(() => setDone(true));
  }, [ready, createAlertFromSearch]);

  return null;
}
