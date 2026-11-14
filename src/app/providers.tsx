"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, useEffect, useState } from "react";
import { Navbar, showsNavbar } from "@/components/Navbar";
import { SitePillFallback } from "@/components/SiteHeader";
import { usePublicPathname } from "@/hooks/use-public-pathname";
import { AuthProvider } from "@/components/AuthProvider";
import { LaunchOfferProvider } from "@/components/LaunchOfferProvider";
import { PendingAlertRunner } from "@/components/PendingAlertRunner";
import { LazyToaster } from "@/components/LazyToaster";
import { retryUnlessRefused } from "@/lib/query-retry";
import { getWithdrawnSources, loadWithdrawnSourcesOncePerSession } from "@/lib/withdrawn-sources";
import { createWithdrawnSourcesClient } from "@/lib/withdrawn-sources-client";

/** Délai au bout duquel la lecture part même si le navigateur reste occupé. */
export const WITHDRAWN_SOURCES_IDLE_TIMEOUT_MS = 3_000;

/**
 * Exécute `callback` au premier repos du navigateur (`requestIdleCallback`, repli `setTimeout` pour
 * Safari), et au plus tard après `timeoutMs`. Renvoie la fonction qui l'annule.
 */
export function runWhenBrowserIsIdle(callback: () => void, timeoutMs: number): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(callback, { timeout: timeoutMs });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = window.setTimeout(callback, Math.min(timeoutMs, 1_000));
  return () => window.clearTimeout(timer);
}

/**
 * Sources retirées du catalogue (aucune à ce jour) : la liste vient de la base (interrupteur unique).
 * Lue une fois par session de navigation, sans charger supabase-js (appel REST anonyme), et
 * seulement quand le navigateur est au repos : l'appel ne concurrence ni le premier affichage ni
 * l'hydratation. Le serveur masque déjà les ventes dont toutes les sources sont retirées ; cette
 * liste ne sert qu'à retirer les liens, photos et pièces d'une source retirée sur une vente fusionnée.
 * Si elle diffère de celle déjà appliquée, les données déjà affichées sont relues.
 */
export function useDeferredWithdrawnSources(queryClient: QueryClient) {
  useEffect(() => {
    let cancelled = false;
    const cancelIdle = runWhenBrowserIsIdle(() => {
      const before = [...getWithdrawnSources()].sort().join(",");
      void loadWithdrawnSourcesOncePerSession(createWithdrawnSourcesClient()).then((names) => {
        if (!cancelled && [...names].sort().join(",") !== before)
          void queryClient.invalidateQueries();
      });
    }, WITHDRAWN_SOURCES_IDLE_TIMEOUT_MS);
    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [queryClient]);
}

export function AppProviders({
  children,
  footer,
}: {
  children: React.ReactNode;
  /** Le pied de page public, composé par le layout : une partie y est rendue côté serveur. */
  footer: React.ReactNode;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // Une panne est retentée une fois ; une recherche refusée par la route (400) ne l'est jamais.
        defaultOptions: { queries: { retry: retryUnlessRefused, staleTime: 60_000 } },
      }),
  );

  useDeferredWithdrawnSources(queryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <LaunchOfferProvider>
          <div className="min-h-screen bg-background">
            <Suspense fallback={<NavigationFallback />}>
              <Navbar />
            </Suspense>
            {children}
            {footer}
            <PendingAlertRunner />
            <LazyToaster />
          </div>
        </LaunchOfferProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

/**
 * En-tête de secours le temps que le vrai se charge : la pilule, à la place exacte de la vraie (même
 * position, même largeur, même espace réservé dans la page) ; le catalogue et l'administration n'en
 * ont pas (leur propre barre). Un espace laissé là où le vrai en-tête n'en laisse pas décalait la
 * page à son arrivée (CLS 0,078).
 */
export function NavigationFallback() {
  if (!showsNavbar(usePublicPathname())) return null;
  return <SitePillFallback />;
}
