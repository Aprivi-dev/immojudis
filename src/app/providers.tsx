"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { Toaster } from "sonner";
import { Navbar } from "@/components/Navbar";
import { AuthProvider } from "@/components/AuthProvider";
import { SiteFooter } from "@/components/SiteFooter";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, staleTime: 60_000 } },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <div className="min-h-screen bg-background">
          <Suspense fallback={<NavigationFallback />}>
            <Navbar />
          </Suspense>
          {children}
          <SiteFooter />
          <Toaster position="top-right" richColors />
        </div>
      </AuthProvider>
    </QueryClientProvider>
  );
}

function NavigationFallback() {
  return (
    <header className="ij-site-header">
      <div className="ij-site-header-inner">
        <a href="/" className="font-display text-2xl font-semibold text-foreground">
          Immo<span className="text-gold-text">Judis</span>
        </a>
        <nav className="ij-home-nav" aria-label="Navigation principale">
          <a href="/sales">Rechercher un bien</a>
          <a href="/avocats">Trouver un avocat</a>
          <a href="/ressources">Ressources</a>
        </nav>
      </div>
    </header>
  );
}
