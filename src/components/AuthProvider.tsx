"use client";

import { useLayoutEffect, useState } from "react";
import { AuthContext, createAuthStore, useVerifiedAuth } from "@/hooks/use-auth";
import { usePathname } from "next/navigation";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(createAuthStore);
  const auth = useVerifiedAuth(true, usePathname());
  // La valeur du contexte reste le même magasin : seuls les consommateurs déjà montés sont
  // réveillés (voir `createAuthStore`). Publié avant l'affichage : un changement d'identité ne
  // laisse pas une image avec l'ancien état.
  useLayoutEffect(() => {
    store.publish(auth);
  });
  return <AuthContext.Provider value={store}>{children}</AuthContext.Provider>;
}
