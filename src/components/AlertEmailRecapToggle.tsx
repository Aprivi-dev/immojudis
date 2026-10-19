import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  fetchAccessPlan,
  fetchNotificationPreferences,
  updateNotificationPreferences,
} from "@/lib/client-api";
import { queryKeys } from "@/lib/query-keys";
import { userMessage } from "@/lib/user-messages";

/**
 * Interrupteur de l'email récapitulatif des alertes, partagé par la cloche des notifications et
 * la page « Mon compte ». Jamais pré-coché : le consentement est explicite et horodaté côté
 * serveur. Un compte gratuit reçoit un récapitulatif par semaine, l'offre Analyse un par jour.
 */
export function AlertEmailRecapToggle({
  userId,
  className,
}: {
  userId: string;
  /** Mise en forme du conteneur (la cloche et la page de compte n'ont pas la même). */
  className: string;
}) {
  const queryClient = useQueryClient();
  const entitlements = useQuery({
    queryKey: queryKeys.featureEntitlementsPlan(userId),
    queryFn: fetchAccessPlan,
  });
  const hasAnalysisAccess = entitlements.data?.plan.hasAnalysisAccess === true;
  const preferencesQuery = useQuery({
    queryKey: queryKeys.notificationPreferences(userId),
    queryFn: fetchNotificationPreferences,
    staleTime: 60_000,
  });
  const emailEnabled = preferencesQuery.data?.preferences.alertEmailEnabled ?? false;
  const preferencesMutation = useMutation({
    mutationFn: updateNotificationPreferences,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notificationPreferences(userId) });
      toast.success("Préférences mises à jour");
    },
    onError: (error) => toast.error(userMessage(error, "Préférences impossibles")),
  });

  return (
    <label className={className}>
      <span>
        <span className="block font-semibold text-foreground">Alertes email</span>
        <span className="block text-xs text-muted-foreground">
          {emailEnabled
            ? hasAnalysisAccess
              ? "Consentement actif"
              : "Consentement actif : un email récapitulatif par semaine"
            : hasAnalysisAccess
              ? "Notifications dans l’application uniquement"
              : "Cochez pour recevoir un email récapitulatif chaque semaine"}
        </span>
      </span>
      <input
        type="checkbox"
        checked={emailEnabled}
        disabled={preferencesQuery.isLoading || preferencesMutation.isPending}
        onChange={(event) =>
          preferencesMutation.mutate({
            alertEmailEnabled: event.target.checked,
            consentSource: "settings",
          })
        }
        className="h-4 w-4 accent-[var(--gold)]"
      />
    </label>
  );
}
