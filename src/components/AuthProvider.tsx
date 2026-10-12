"use client";

import { AuthContext, useVerifiedAuth } from "@/hooks/use-auth";
import { usePathname } from "next/navigation";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const auth = useVerifiedAuth(true, usePathname());
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}
