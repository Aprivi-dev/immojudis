"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, useEffect, useState } from "react";
import { Navbar, navbarTheme } from "@/components/Navbar";
import { HeaderLogo } from "@/components/site-header-shared";
import {
  siteHeaderBarClasses,
  siteHeaderClasses,
  siteHeaderReservesHeight,
} from "@/components/SiteHeader";
import { usePublicPathname } from "@/hooks/use-public-pathname";
import { AuthProvider } from "@/components/AuthProvider";
import { LaunchOfferProvider } from "@/components/LaunchOfferProvider";
import { PendingAlertRunner } from "@/components/PendingAlertRunner";
import { SiteFooter } from "@/components/SiteFooter";
import { LazyToaster } from "@/components/LazyToaster";
import { retryUnlessRefused } from "@/lib/query-retry";
import { getWithdrawnSources, loadWithdrawnSourcesOncePerSession } from "@/lib/withdrawn-sources";
import { createWithdrawnSourcesClient } from "@/lib/withdrawn-sources-client";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // Une panne est retentée une fois ; une recherche refusée par la route (400) ne l'est jamais.
        defaultOptions: { queries: { retry: retryUnlessRefused, staleTime: 60_000 } },
      }),
  );

  useEffect(() => {
    // Sources retirées du catalogue (aucune à ce jour) : la liste vient de la base (interrupteur unique).
    // Lue une fois par session de navigation, sans charger supabase-js (appel REST anonyme).
    // Si elle diffère de celle déjà appliquée, les données déjà affichées sont relues.
    let cancelled = false;
    const before = [...getWithdrawnSources()].sort().join(",");
    void loadWithdrawnSourcesOncePerSession(createWithdrawnSourcesClient()).then((names) => {
      if (!cancelled && [...names].sort().join(",") !== before)
        void queryClient.invalidateQueries();
    });
    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <LaunchOfferProvider>
          <div className="min-h-screen bg-background">
            <Suspense fallback={<NavigationFallback />}>
              <Navbar />
            </Suspense>
            {children}
            <SiteFooter />
            <PendingAlertRunner />
            <LazyToaster />
          </div>
        </LaunchOfferProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

/**
 * En-tête de secours le temps que le vrai se charge. Il prend la place exacte du vrai pour l'adresse
 * courante (même thème, même position, même hauteur, même espace réservé dans la page) : l'accueil
 * porte un en-tête sombre posé par-dessus la photo, qui ne réserve aucune place ; le catalogue et
 * l'administration n'en ont pas (leur propre barre). Un espace de 4 rem laissé là où le vrai en-tête
 * n'en laisse pas décalait la page à son arrivée (CLS 0,078).
 */
export function NavigationFallback() {
  const theme = navbarTheme(usePublicPathname());
  if (!theme) return null;
  return (
    <>
      <header className={siteHeaderClasses(theme, "fixed")}>
        <div className={siteHeaderBarClasses(theme)}>
          <HeaderLogo dark={theme === "dark"} showTagline={theme !== "dark"} />
        </div>
      </header>
      {siteHeaderReservesHeight(theme, "fixed") ? <div className="h-16" aria-hidden /> : null}
    </>
  );
}
