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
  // Limite connue : les consommateurs lisent le magasin, publié après le commit du fournisseur. Un
  // composant monté dans la même passe qu'un changement d'identité peut donc faire un rendu, et
  // exécuter ses effets une fois, avec l'état précédent avant le rendu synchrone de correction.
  // Aucune décision d'accès ni écriture ne doit reposer sur `user` côté client sans passer par
  // `loading` et par le serveur.
  useLayoutEffect(() => {
    store.publish(auth);
  });
  return <AuthContext.Provider value={store}>{children}</AuthContext.Provider>;
}
