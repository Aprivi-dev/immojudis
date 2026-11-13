import { useNotificationPreferenceToggle } from "@/hooks/use-notification-preference-toggle";
import {
  consentOffered,
  useNotificationPreferencesQuery,
} from "@/hooks/use-notification-preferences";

/**
 * Case de l'alerte de résultat ou de remise en vente d'une vente suivie (favoris, ventes débloquées) :
 * un email quand la vente a eu lieu, est retirée ou annulée, ou est remise en vente, avec un lien vers
 * la fiche ou « Mes favoris ». Jamais de prix dans l'email. Consentement distinct de celui des alertes
 * et de celui des rappels d'audience, jamais pré-coché, retirable à tout moment.
 *
 * La case n'est proposée que si l'envoi est ouvert à cette personne (`SALE_RESULTS_MODE`, voir
 * `saleResultsAvailable`) : on ne recueille pas de consentement pour un envoi qui n'a pas lieu. Une
 * personne qui a déjà consenti la voit toujours, pour pouvoir la retirer. Affichée dans `/compte`
 * (Notifications). Le texte qu'elle présente est celui dont la version est
 * `SALE_RESULTS_CONSENT_TEXT_VERSION` (`notification-preferences.ts`) : à changer avec lui. Comme
 * pour les rappels d'audience (relecture juridique du 20/10/2026) : le retrait est annoncé avant la
 * case et aucun envoi n'est garanti.
 */
export function SaleResultsToggle({ userId, className }: { userId: string; className: string }) {
  const preferencesQuery = useNotificationPreferencesQuery(userId);
  const mutation = useNotificationPreferenceToggle(userId, {
    saved: (update) =>
      update.saleResultsEnabled ? "Alertes de résultat activées" : "Alertes de résultat retirées",
    failed: "Alertes de résultat : enregistrement impossible",
  });

  const data = preferencesQuery.data;
  const enabled = data?.preferences.saleResultsEnabled ?? false;
  if (!data || !consentOffered(data.saleResultsAvailable, enabled)) return null;

  return (
    <label className={className}>
      <span>
        <span className="block font-semibold text-foreground">
          Me prévenir du résultat ou de la remise en vente
        </span>
        <span className="block text-foreground">
          Quand une vente que je suis a eu lieu, est retirée ou est remise en vente
        </span>
        <span className="mt-1 block text-foreground">
          Retirable à tout moment, ici ou par le lien de désinscription de chaque email.
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
          {enabled
            ? data.saleResultsAvailable
              ? "Alertes de résultat activées. "
              : "Alertes de résultat activées ; les envois sont suspendus pour le moment. "
            : "Pour vos favoris et vos ventes débloquées. L’email ne donne aucun prix : il renvoie vers la fiche ou vers « Mes favoris ». "}
          Les envois dépendent des informations publiées par les sources ; aucun envoi n’est
          garanti. Statut à vérifier auprès de l’avocat poursuivant.
        </span>
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
            saleResultsEnabled: event.target.checked,
            consentSource: "settings",
          });
        }}
        className="h-4 w-4 accent-[var(--gold)]"
      />
    </label>
  );
}
