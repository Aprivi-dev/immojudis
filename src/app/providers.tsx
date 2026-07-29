"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { Toaster } from "sonner";
import { Navbar } from "@/components/Navbar";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-background">
        <Suspense fallback={<NavigationFallback />}>
          <Navbar />
        </Suspense>
        {children}
        <Toaster position="top-right" richColors />
      </div>
    </QueryClientProvider>
  );
}

function NavigationFallback() {
  return (
    <header className="ij-site-header">
      <div className="ij-site-header-inner">
        <a href="/" className="font-display text-2xl font-semibold text-foreground">
          Immo<span className="text-gold">Judis</span>
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
