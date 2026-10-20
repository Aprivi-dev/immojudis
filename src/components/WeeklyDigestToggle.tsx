import { useId } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import { fetchNotificationPreferences, updateNotificationPreferences } from "@/lib/client-api";
import { queryKeys } from "@/lib/query-keys";
import { userMessage } from "@/lib/user-messages";

/** Jours proposés, dans l'ordre de la semaine (ISO 8601 : 1 = lundi ... 7 = dimanche). */
const WEEKDAYS = [
  { value: 1, label: "lundi" },
  { value: 2, label: "mardi" },
  { value: 3, label: "mercredi" },
  { value: 4, label: "jeudi" },
  { value: 5, label: "vendredi" },
  { value: 6, label: "samedi" },
  { value: 7, label: "dimanche" },
] as const;

/**
 * Case du récapitulatif hebdomadaire « Ma semaine » : un seul email par semaine, au jour choisi (le
 * mardi par défaut), avec les audiences des 14 prochains jours, ce qui a changé sur les ventes suivies
 * et les nouvelles ventes du département des alertes. Consentement distinct de celui des alertes et de
 * celui des rappels d'audience, jamais pré-coché, retirable à tout moment.
 *
 * La case n'est proposée que si l'envoi est ouvert à cette personne (`WEEKLY_DIGEST_MODE`, voir
 * `weeklyDigestAvailable`) : on ne recueille pas de consentement pour un envoi qui n'a pas lieu. Une
 * personne qui a déjà consenti la voit toujours, pour pouvoir la retirer. Affichée dans `/compte`
 * (Notifications). Le texte qu'elle présente est celui dont la version est
 * `WEEKLY_DIGEST_CONSENT_TEXT_VERSION` (`notification-preferences.ts`) : à changer avec lui. Comme
 * pour les rappels d'audience (relecture juridique du 20/10/2026) : le retrait est annoncé avant la
 * case et aucun envoi n'est garanti.
 */
export function WeeklyDigestToggle({ userId, className }: { userId: string; className: string }) {
  const queryClient = useQueryClient();
  const weekdayId = useId();
  const preferencesQuery = useQuery({
    queryKey: queryKeys.notificationPreferences(userId),
    queryFn: fetchNotificationPreferences,
    staleTime: 60_000,
  });
  const mutation = useMutation({
    mutationFn: updateNotificationPreferences,
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notificationPreferences(userId) });
      if (variables.weeklyDigestEnabled !== undefined) {
        toast.success(
          variables.weeklyDigestEnabled
            ? "Récapitulatif hebdomadaire activé"
            : "Récapitulatif hebdomadaire retiré",
        );
      } else {
        toast.success("Jour du récapitulatif enregistré");
      }
    },
    onError: (error) =>
      toast.error(userMessage(error, "Récapitulatif hebdomadaire : enregistrement impossible")),
  });

  const data = preferencesQuery.data;
  const enabled = data?.preferences.weeklyDigestEnabled ?? false;
  if (!data || (data.weeklyDigestAvailable !== true && !enabled)) return null;
  const weekday = data.preferences.weeklyDigestWeekday ?? 2;

  return (
    <div className={`${className} flex-wrap`}>
      <label className="flex min-w-0 flex-1 items-center justify-between gap-3">
        <span>
          <span className="block font-semibold text-foreground">
            Recevoir « Ma semaine » : un récapitulatif par semaine
          </span>
          <span className="block text-foreground">
            Mes audiences des 14 prochains jours, ce qui a changé sur mes ventes suivies et les
            nouvelles ventes de mon département
          </span>
          <span className="mt-1 block text-foreground">
            Retirable à tout moment, ici ou par le lien de désinscription de chaque email.
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            {enabled
              ? data.weeklyDigestAvailable
                ? "Récapitulatif activé. "
                : "Récapitulatif activé ; les envois sont suspendus pour le moment. "
              : "Un seul email par semaine, jamais le jour où un autre email d’Immojudis vous est déjà parvenu. "}
            Les envois dépendent des informations publiées par les sources ; aucun envoi n’est
            garanti. Dates à vérifier auprès de l’avocat poursuivant.
          </span>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          // `aria-busy` plutôt que `disabled` : la case garde le focus pendant l'enregistrement ; le
          // clic est ignoré tant qu'il dure.
          aria-busy={mutation.isPending}
          onChange={(event) => {
            if (mutation.isPending) return;
            mutation.mutate({
              weeklyDigestEnabled: event.target.checked,
              consentSource: "settings",
            });
          }}
          className="h-4 w-4 accent-[var(--gold)]"
        />
      </label>
      {enabled ? (
        <div className="flex w-full basis-full items-center gap-2 text-sm">
          <label htmlFor={weekdayId} className="font-semibold text-foreground">
            Jour d’envoi
          </label>
          <select
            id={weekdayId}
            value={weekday}
            aria-busy={mutation.isPending}
            onChange={(event) => {
              if (mutation.isPending) return;
              mutation.mutate({
                weeklyDigestWeekday: Number(event.target.value),
                consentSource: "settings",
              });
            }}
            className="form-input min-h-11"
          >
            {WEEKDAYS.map((day) => (
              <option key={day.value} value={day.value}>
                {day.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}
