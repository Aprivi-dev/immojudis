import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import { fetchNotificationPreferences, updateNotificationPreferences } from "@/lib/client-api";
import { queryKeys } from "@/lib/query-keys";
import { userMessage } from "@/lib/user-messages";

/**
 * Case des rappels d'audience sur les ventes suivies (favoris, ventes débloquées), avec l'avertissement
 * qui les accompagne (date modifiée, vente retirée, reportée, annulée ou adjugée). Consentement
 * distinct de celui des alertes email, jamais pré-coché, retirable à tout moment. La case n'est
 * proposée que si l'envoi est ouvert à cette personne (`SALE_REMINDERS_MODE`, voir
 * `saleRemindersAvailable`) : on ne recueille pas de consentement pour un envoi qui n'a pas lieu. Une
 * personne qui a déjà consenti la voit toujours, pour pouvoir la retirer.
 *
 * Affichée dans `/compte` (Notifications) et dans « Mon dossier » d'une vente suivie. Le texte qu'elle
 * présente est celui dont la version est `SALE_REMINDERS_CONSENT_TEXT_VERSION` : à changer avec lui.
 * Un seul libellé (relecture juridique du 20/10/2026, à faire valider par un avocat), le retrait
 * annoncé AVANT la case, et la mention qu'aucun envoi n'est garanti. Un seul vocabulaire, « rappels
 * d'audience », pour les explications et les messages.
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
    onError: (error) =>
      toast.error(userMessage(error, "Rappels d’audience : enregistrement impossible")),
  });

  const data = preferencesQuery.data;
  const enabled = data?.preferences.saleRemindersEnabled ?? false;
  if (!data || (!data.saleRemindersAvailable && !enabled)) return null;

  return (
    <label className={className}>
      <span>
        <span className="block font-semibold text-foreground">
          Me prévenir par email : rappel 7 jours avant puis la veille de l’audience, et si la date
          change ou si la vente est retirée, reportée, annulée ou adjugée
        </span>
        <span className="mt-1 block text-foreground">
          Retirable à tout moment, ici ou par le lien de désinscription de chaque email.
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
          {enabled
            ? data.saleRemindersAvailable
              ? "Rappels d’audience activés. "
              : "Rappels d’audience activés ; les envois sont suspendus pour le moment. "
            : "Pour vos favoris et vos ventes débloquées. "}
          Les envois dépendent des informations publiées par les sources ; aucun envoi n’est
          garanti. Dates à vérifier auprès de l’avocat poursuivant.
        </span>
      </span>
      <input
        type="checkbox"
        checked={enabled}
        // `aria-busy` plutôt que `disabled` : la case garde le focus pendant l'enregistrement (un
        // lecteur d'écran n'est pas expulsé de la case) ; le clic est ignoré tant qu'il dure.
        aria-busy={mutation.isPending}
        onChange={(event) => {
          if (mutation.isPending) return;
          mutation.mutate({
            saleRemindersEnabled: event.target.checked,
            consentSource: "settings",
          });
        }}
        className="h-4 w-4 accent-[var(--gold)]"
      />
    </label>
  );
}
