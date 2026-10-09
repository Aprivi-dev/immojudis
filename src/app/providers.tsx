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
    <>
      <header className="fixed inset-x-0 top-0 z-50 border-b border-border bg-white/95">
        <div className="mx-auto flex min-h-16 max-w-[96rem] items-center gap-4 px-4 sm:px-6 lg:px-8">
          <a href="/" className="font-display text-2xl font-semibold text-foreground">
            Immo<span className="text-gold-text">judis</span>
          </a>
        </div>
      </header>
      <div className="h-16" aria-hidden />
    </>
  );
}
