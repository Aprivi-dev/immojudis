import { useQuery } from "@tanstack/react-query";
import { fetchNotificationPreferences } from "@/lib/client-api";
import * as queryKeys from "@/lib/query-keys";

/**
 * Préférences de notification du compte : une seule lecture, partagée par la cloche, « Mon compte »,
 * la recherche, la fiche et « Mon démarrage ». `enabled` ajoute une condition à la session.
 * L'écriture est dans `use-notification-preference-toggle.ts` : la recherche, qui ne fait que lire,
 * n'en charge pas le code.
 */
export function useNotificationPreferencesQuery(
  userId: string | null | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.notificationPreferences(userId ?? "anonymous"),
    queryFn: fetchNotificationPreferences,
    enabled: Boolean(userId) && enabled,
    staleTime: 60_000,
  });
}

/**
 * Une case de consentement n'est proposée que si l'envoi est ouvert à cette personne ; une personne
 * qui a déjà consenti la voit toujours, pour pouvoir retirer son accord.
 */
export function consentOffered(available: boolean | undefined, enabled: boolean): boolean {
  return available === true || enabled;
}
