"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { Toaster } from "sonner";
import { AuthGate } from "@/components/AuthGate";
import { Navbar } from "@/components/Navbar";

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-background">
        <Suspense fallback={null}>
          <Navbar />
          <AuthGate>{children}</AuthGate>
        </Suspense>
        <Toaster position="top-right" richColors />
      </div>
    </QueryClientProvider>
  );
}
