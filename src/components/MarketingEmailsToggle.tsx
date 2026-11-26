import { useNotificationPreferenceToggle } from "@/hooks/use-notification-preference-toggle";
import {
  consentOffered,
  useNotificationPreferencesQuery,
} from "@/hooks/use-notification-preferences";
import { MARKETING_EMAILS_CONSENT_TEXT } from "@/lib/marketing-emails-consent";

/**
 * Réglage « Nouveautés et offres » de `/compte` (Notifications), sur le modèle de
 * `WeeklyDigestToggle` : consentement distinct de tous les autres (prospection commerciale), jamais
 * pré-coché, retirable à tout moment. Le texte est celui de la case de `/bienvenue`
 * (`MARKETING_EMAILS_CONSENT_TEXT`).
 *
 * Proposé seulement si `MARKETING_EMAILS_MODE` l'ouvre à cette personne (`marketingEmailsAvailable`) :
 * on ne recueille pas de consentement pour un envoi qui n'a pas lieu. Une personne qui a déjà consenti
 * le voit toujours, pour pouvoir retirer son accord.
 */
export function MarketingEmailsToggle({
  userId,
  className,
}: {
  userId: string;
  className: string;
}) {
  const preferencesQuery = useNotificationPreferencesQuery(userId);
  const mutation = useNotificationPreferenceToggle(userId, {
    saved: (update) =>
      update.marketingEmailsEnabled
        ? "Nouveautés et offres activées"
        : "Nouveautés et offres retirées",
    failed: "Nouveautés et offres : enregistrement impossible",
  });

  const data = preferencesQuery.data;
  const enabled = data?.preferences.marketingEmailsEnabled ?? false;
  if (!data || !consentOffered(data.marketingEmailsAvailable, enabled)) return null;

  return (
    <label className={className}>
      <span>
        <span className="block font-semibold text-foreground">Nouveautés et offres</span>
        <span className="block text-foreground">{MARKETING_EMAILS_CONSENT_TEXT}</span>
      </span>
      <input
        type="checkbox"
        checked={enabled}
        // `aria-busy` plutôt que `disabled` : la case garde le focus pendant l'enregistrement ; le clic
        // est ignoré tant qu'il dure.
        aria-busy={mutation.isPending}
        onChange={(event) => {
          if (mutation.isPending) return;
          mutation.mutate({
            marketingEmailsEnabled: event.target.checked,
            consentSource: "settings",
          });
        }}
        className="h-4 w-4 accent-[var(--gold)]"
      />
    </label>
  );
}
