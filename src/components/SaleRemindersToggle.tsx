import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import { fetchNotificationPreferences, updateNotificationPreferences } from "@/lib/client-api";
import { queryKeys } from "@/lib/query-keys";
import { userMessage } from "@/lib/user-messages";

/**
 * Case des rappels d'audience et avertissements graves sur les ventes suivies (favoris, ventes
 * débloquées). Consentement distinct de celui des alertes email, jamais pré-coché, retirable à
 * tout moment. La case n'est proposée que si l'envoi est ouvert à cette personne
 * (`SALE_REMINDERS_MODE`, voir `saleRemindersAvailable`) : on ne recueille pas de consentement
 * pour un envoi qui n'a pas lieu. Une personne qui a déjà consenti la voit toujours, pour pouvoir
 * la retirer.
 */
export function SaleRemindersToggle({ userId, className }: { userId: string; className: string }) {
  const queryClient = useQueryClient();
  const preferencesQuery = useQuery({
    queryKey: queryKeys.notificationPreferences(userId),
    queryFn: fetchNotificationPreferences,
    staleTime: 60_000,
  });
  const mutation = useMutation({
    mutationFn: updateNotificationPreferences,
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notificationPreferences(userId) });
      toast.success(
        variables.saleRemindersEnabled
          ? "Rappels d’audience activés"
          : "Rappels d’audience retirés",
      );
    },
    onError: (error) => toast.error(userMessage(error, "Préférences impossibles")),
  });

  const data = preferencesQuery.data;
  const enabled = data?.preferences.saleRemindersEnabled ?? false;
  if (!data || (!data.saleRemindersAvailable && !enabled)) return null;

  return (
    <label className={className}>
      <span>
        <span className="block font-semibold text-foreground">
          Rappels d’audience et avertissements
        </span>
        <span className="block text-xs leading-relaxed text-muted-foreground">
          {enabled
            ? data.saleRemindersAvailable
              ? "Consentement actif. Vous pouvez le retirer à tout moment, ici ou par le lien de désinscription de chaque email."
              : "Consentement actif ; les envois sont suspendus pour le moment. Vous pouvez le retirer ici."
            : "Cochez pour recevoir un email 7 jours puis la veille de l’audience d’un de vos favoris ou d’une vente débloquée, et un email si sa date change ou si elle est retirée, reportée ou adjugée. Dates à vérifier auprès de l’avocat poursuivant."}
        </span>
      </span>
      <input
        type="checkbox"
        checked={enabled}
        disabled={mutation.isPending}
        onChange={(event) =>
          mutation.mutate({ saleRemindersEnabled: event.target.checked, consentSource: "settings" })
        }
        className="h-4 w-4 accent-[var(--gold)]"
      />
    </label>
  );
}
