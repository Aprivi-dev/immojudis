"use client";

import { useQuery } from "@tanstack/react-query";
import { AdminPanel, AdminSectionHeading, AdminShell } from "@/components/admin/AdminShell";
import { formatDateTime, formatInteger, queryErrorMessage } from "@/components/admin/admin-format";
import { AdminPanelLoading, useAdminRefresh } from "@/components/admin/admin-ui";
import { useAuth } from "@/hooks/use-auth";
import type { BidCeilingSummary } from "@/lib/admin-bid-ceilings";
import type {
  AdminPilotageResponse,
  PilotageCount,
  PilotagePeriod,
  SaleReminderAccuracy,
  SaleReminderAccuracyVerdict,
} from "@/lib/admin-pilotage";
import type {
  SaleSignalFeedbackSummary,
  SignalFeedbackCounts,
} from "@/lib/admin-sale-signal-feedback";
import { fetchAdminPilotage } from "@/lib/client-api/admin";
import { SALE_SIGNAL_REASON_LABELS, type SaleSignal } from "@/lib/sale-signal-feedback";

export const PILOTAGE_QUERY_KEY = ["admin-pilotage"] as const;

/** Libellé d'un chiffre absent : jamais un zéro à la place. */
export const NOT_MEASURED = "non mesuré";

/** Un nombre inférieur à ce seuil n'est pas affiché : avec peu de comptes, il désigne des personnes. */
export const PILOTAGE_MASK_BELOW = 5;
export const MASKED = `moins de ${PILOTAGE_MASK_BELOW}`;

/** Sous ce nombre de comptes, les chiffres ne permettent pas de conclure. */
export const PILOTAGE_MIN_ACCOUNTS = 30;

type Row = {
  label: string;
  value: (period: PilotagePeriod) => PilotageCount;
  /** Comptes distincts, affichés sous les occurrences. */
  accounts?: (period: PilotagePeriod) => PilotageCount;
  /** Ligne de détail d'une ligne précédente (retrait à gauche). */
  detail?: boolean;
  /** Les événements n'existent que depuis le début de la mesure. */
  event?: boolean;
};

type Section = { title: string; rows: Row[] };

/** Plafonds quotidiens d'avant la distinction compte / adresse : le total moins les deux détails. */
function dailyUndistinguished(period: PilotagePeriod): PilotageCount {
  const { daily, dailyAccount, dailyShared } = period.events.quotaReached;
  if (daily == null || dailyAccount == null || dailyShared == null) return null;
  return Math.max(0, daily - dailyAccount - dailyShared);
}

const SECTIONS: Section[] = [
  {
    title: "Comptes (administrateurs exclus)",
    rows: [
      { label: "Inscriptions (comptes créés)", value: (p) => p.signups },
      {
        label: "dont adresse email confirmée",
        value: (p) => p.signupsConfirmed,
        detail: true,
      },
      { label: "Comptes actifs (au moins une connexion)", value: (p) => p.activeAccounts },
      {
        label: "dont nouveaux (créés dans la période)",
        value: (p) => p.activeNew,
        detail: true,
      },
      {
        label: "dont revenus (créés avant la période)",
        value: (p) => p.activeReturning,
        detail: true,
      },
    ],
  },
  {
    title: "Parcours (événements : occurrences, puis comptes distincts)",
    rows: [
      {
        label: "Déblocages de ventes",
        value: (p) => p.events.unlocks,
        accounts: (p) => p.events.accounts.unlocks,
        event: true,
      },
      {
        label: "Quotas atteints",
        value: (p) => p.events.quotaReached.total,
        accounts: (p) => p.events.accounts.quotaReached.total,
        event: true,
      },
      {
        label: "dont déblocages du mois",
        value: (p) => p.events.quotaReached.unlocks,
        accounts: (p) => p.events.accounts.quotaReached.unlocks,
        detail: true,
        event: true,
      },
      {
        label: "dont favoris",
        value: (p) => p.events.quotaReached.favorites,
        accounts: (p) => p.events.accounts.quotaReached.favorites,
        detail: true,
        event: true,
      },
      {
        label: "dont plafonds quotidiens",
        value: (p) => p.events.quotaReached.daily,
        accounts: (p) => p.events.accounts.quotaReached.daily,
        detail: true,
        event: true,
      },
      {
        label: "plafond quotidien du compte (limite par compte)",
        value: (p) => p.events.quotaReached.dailyAccount,
        accounts: (p) => p.events.accounts.quotaReached.dailyAccount,
        detail: true,
        event: true,
      },
      {
        label: "plafond quotidien de l’adresse ou du site (limite partagée)",
        value: (p) => p.events.quotaReached.dailyShared,
        accounts: (p) => p.events.accounts.quotaReached.dailyShared,
        detail: true,
        event: true,
      },
      {
        label: "plafond quotidien, avant la distinction compte / adresse",
        value: dailyUndistinguished,
        detail: true,
        event: true,
      },
      {
        label: "Plafonds d’enchère calculés",
        value: (p) => p.events.bidCeilings,
        accounts: (p) => p.events.accounts.bidCeilings,
        event: true,
      },
      {
        label: "Exports agenda (.ics)",
        value: (p) => p.events.calendarExports,
        accounts: (p) => p.events.accounts.calendarExports,
        event: true,
      },
      {
        label: "Clics d’email",
        value: (p) => p.events.emailClicks.total,
        accounts: (p) => p.events.accounts.emailClicks.total,
        event: true,
      },
      {
        label: "dont alertes",
        value: (p) => p.events.emailClicks.alert,
        accounts: (p) => p.events.accounts.emailClicks.alert,
        detail: true,
        event: true,
      },
      {
        label: "dont rappels d’audience",
        value: (p) => p.events.emailClicks.reminder,
        accounts: (p) => p.events.accounts.emailClicks.reminder,
        detail: true,
        event: true,
      },
    ],
  },
  {
    title: "Dossiers et rappels",
    rows: [
      {
        label: "Dossiers enregistrés (statut ou enchère plafond sur un favori)",
        value: (p) => p.dossiers,
        accounts: (p) => p.dossierAccounts,
      },
      {
        label: "Rappels d’audience envoyés",
        value: (p) => p.remindersSent,
        accounts: (p) => p.reminderAccounts,
      },
    ],
  },
  {
    title: "Alertes",
    rows: [{ label: "Alertes créées", value: (p) => p.alertsCreated }],
  },
  {
    title: "Intérêt pour l’offre Analyse (liste d’attente)",
    rows: [{ label: "Demandes « Me prévenir de l’ouverture »", value: (p) => p.waitlistRequests }],
  },
];

/** Un nombre à afficher : « non mesuré », « moins de 5 » ou le nombre lui-même. */
export function formatCount(value: PilotageCount): string {
  if (value == null) return NOT_MEASURED;
  return value < PILOTAGE_MASK_BELOW ? MASKED : formatInteger(value);
}

/** Critère écrit de passage des rappels à `on` (voir `docs/runbooks/activation-rappels-audience.md`). */
const REMINDER_FALSE_ALERT_MAX_PERCENT = 2;
const REMINDER_FALSE_ALERT_MIN_SAMPLE = 100;

export const REMINDER_VERDICT_LABELS: Record<SaleReminderAccuracyVerdict, string> = {
  met: "Critère atteint : le passage à « on » est justifié",
  not_met: "Critère non atteint : les rappels restent en « internal »",
  insufficient_sample: "Échantillon insuffisant : on ne conclut pas",
  unavailable: "Mesure indisponible",
};

/** Un taux entre 0 et 1 en pourcentage (« 1,5 % ») ; masqué sous le seuil d'affichage de la page. */
export function formatReminderRate(accuracy: SaleReminderAccuracy | null): string {
  if (!accuracy || accuracy.contradictionRate == null) return NOT_MEASURED;
  if (accuracy.measuredReminders != null && accuracy.measuredReminders < PILOTAGE_MASK_BELOW) {
    return MASKED;
  }
  const percent = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(
    accuracy.contradictionRate * 100,
  );
  return `${percent} %`;
}

function formatDay(value: string): string {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(new Date(value));
}

export function AdminPilotagePage() {
  const { user } = useAuth();
  const { isRefreshing, refresh } = useAdminRefresh(PILOTAGE_QUERY_KEY);
  const query = useQuery({
    queryKey: PILOTAGE_QUERY_KEY,
    queryFn: fetchAdminPilotage,
    staleTime: 60_000,
  });

  return (
    <AdminShell
      activeSection="pilotage"
      title="Pilotage"
      description="Chiffres exacts des 7 et 30 derniers jours, sans liste de personnes."
      adminEmail={user?.email}
      onRefresh={() => void refresh()}
      isRefreshing={isRefreshing}
    >
      <div className="max-w-5xl">
        {query.isPending ? <AdminPanelLoading label="des chiffres de pilotage" /> : null}
        {query.isError ? (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
          >
            {queryErrorMessage(query.error, "Pilotage indisponible")}
            <button
              type="button"
              className="admin-button-secondary mt-3 block"
              onClick={() => void query.refetch()}
            >
              Réessayer
            </button>
          </div>
        ) : null}
        {query.data ? <PilotageTables data={query.data} /> : null}
      </div>
    </AdminShell>
  );
}

type Column = { key: string; label: string; period: PilotagePeriod | null };

function PilotageTables({ data }: { data: AdminPilotageResponse }) {
  const week = data.windows.find((window) => window.days === 7);
  const month = data.windows.find((window) => window.days === 30);
  const columns: Column[] = [
    { key: "7", label: "7 jours", period: week ?? null },
    { key: "7-previous", label: "7 jours précédents", period: week?.previous ?? null },
    { key: "30", label: "30 jours", period: month ?? null },
  ];
  const measuredSince = data.eventsMeasuredSince;
  const snapshot = data.snapshot;
  const stateRows: Array<{ label: string; value: PilotageCount }> = [
    { label: "Comptes (administrateurs exclus)", value: snapshot.accountsTotal },
    { label: "dont adresse email confirmée", value: snapshot.accountsConfirmed },
    {
      label: "Consentements actifs aux rappels d’audience",
      value: snapshot.reminderConsentsActive,
    },
    { label: "Dossiers enregistrés en tout", value: snapshot.dossiersTotal },
    { label: "Demandes de liste d’attente actives", value: data.waitlistActive },
    {
      label:
        snapshot.launchOfferActive === false
          ? "Comptes en essai gratuit (essai coupé)"
          : "Comptes en essai gratuit",
      value: snapshot.launchOfferActive === null ? null : snapshot.launchOfferAccounts,
    },
  ];
  const lowVolume =
    snapshot.accountsTotal == null || snapshot.accountsTotal < PILOTAGE_MIN_ACCOUNTS;

  return (
    <>
      {lowVolume ? (
        <p
          role="note"
          className="mb-4 rounded-lg border border-gold/40 bg-gold/10 p-3 text-sm leading-6 text-brand-navy"
        >
          <strong>
            Sous environ {PILOTAGE_MIN_ACCOUNTS} comptes, ces chiffres ne permettent pas de
            conclure.
          </strong>{" "}
          Ils décrivent quelques personnes, pas une tendance : une variation d’un ou deux comptes
          suffit à tout changer.
        </p>
      ) : null}
      <AdminPanel className="p-5">
        <AdminSectionHeading title="Agrégats sur 7 et 30 jours glissants" />
        {/* Texte secondaire en /70 : la description du titre partagé est plus pâle. */}
        <p className="mt-1 text-sm text-brand-navy/70">
          {data.generatedAt ? `Calculés le ${formatDateTime(data.generatedAt)}. ` : ""}
          Une donnée absente s’affiche « {NOT_MEASURED} », jamais zéro ; un nombre inférieur à{" "}
          {PILOTAGE_MASK_BELOW} s’affiche « {MASKED} ».
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <caption className="sr-only">
              Chiffres de pilotage : 7 jours, 7 jours précédents et 30 jours glissants
            </caption>
            <thead>
              <tr className="border-b border-brand-navy/12 text-xs uppercase tracking-[0.08em] text-brand-navy/70">
                <th scope="col" className="py-2 pr-4 font-semibold">
                  Mesure
                </th>
                {columns.map((column) => (
                  <th key={column.key} scope="col" className="px-3 py-2 text-right font-semibold">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            {SECTIONS.map((section) => (
              <tbody key={section.title}>
                <tr>
                  <th
                    scope="rowgroup"
                    colSpan={1 + columns.length}
                    className="pb-1 pt-5 text-left text-xs font-semibold uppercase tracking-[0.08em] text-gold-text"
                  >
                    {section.title}
                  </th>
                </tr>
                {section.rows.map((row) => (
                  <tr key={row.label} className="border-b border-brand-navy/8">
                    <th
                      scope="row"
                      className={`py-2 pr-4 font-normal ${
                        row.detail ? "pl-5 text-brand-navy/70" : "font-medium"
                      }`}
                    >
                      {row.label}
                    </th>
                    {columns.map((column) => {
                      const period = column.period;
                      const value = period ? row.value(period) : null;
                      const accounts = period && row.accounts ? row.accounts(period) : null;
                      const partial =
                        row.event &&
                        period &&
                        value != null &&
                        !period.eventsComplete &&
                        measuredSince;
                      return (
                        <td key={column.key} className="px-3 py-2 text-right tabular-nums">
                          <span
                            className={
                              value == null ? "text-xs text-brand-navy/70" : "font-semibold"
                            }
                          >
                            {formatCount(value)}
                          </span>
                          {accounts != null ? (
                            <span className="block text-xs font-normal text-brand-navy/70">
                              {formatCount(accounts)} comptes
                            </span>
                          ) : null}
                          {partial ? (
                            <span className="block text-xs font-normal text-brand-navy/70">
                              depuis le {formatDay(measuredSince)}
                            </span>
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      </AdminPanel>

      <AdminPanel className="mt-6 p-5">
        <AdminSectionHeading title="État à cet instant" />
        <p className="mt-1 text-sm text-brand-navy/70">
          Ces nombres ne dépendent d’aucune fenêtre.
        </p>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {stateRows.map(({ label, value }) => (
            <div key={label} className="flex items-baseline justify-between gap-3">
              <dt className="text-brand-navy/70">{label}</dt>
              <dd
                className={`tabular-nums ${
                  value == null ? "text-xs text-brand-navy/70" : "font-semibold"
                }`}
              >
                {formatCount(value)}
              </dd>
            </div>
          ))}
        </dl>
      </AdminPanel>

      <ReminderAccuracyCard accuracy={data.saleReminders ?? null} />

      <BidCeilingCard summary={data.bidCeilings ?? null} />

      <SignalFeedbackCard summary={data.signalFeedback ?? null} />

      <AdminPanel className="mt-6 p-5">
        <AdminSectionHeading title="Comment lire ces chiffres" />
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-brand-navy/70">
          <li>
            Les fenêtres sont glissantes (7 ou 30 jours avant le calcul). « 7 jours précédents » est
            la semaine d’avant, sans chevauchement : elle sert à comparer une semaine à la
            précédente. Les administrateurs ne sont comptés nulle part. Aucun nom, aucune adresse :
            des nombres seulement ; un nombre inférieur à {PILOTAGE_MASK_BELOW} est masqué.
          </li>
          <li>
            Pour un événement, le premier nombre est le nombre d’occurrences et le second le nombre
            de comptes distincts : un compte qui atteint un plafond sur dix ventes pèse dix dans
            l’un, un dans l’autre.
          </li>
          <li>
            « Plafond quotidien du compte » : le compte a épuisé sa limite du jour. « Plafond de
            l’adresse ou du site » : la limite de son adresse, ou la limite de tout le site, l’a
            arrêté sans qu’il ait rien épuisé lui-même. Les plafonds d’avant cette distinction sont
            comptés à part.
          </li>
          <li>
            Inscriptions et alertes sont celles qui existent encore : un compte ou une alerte
            supprimé depuis n’est plus compté. Une inscription confirmée est un compte dont
            l’adresse email est confirmée. Un compte actif est un compte dont la dernière connexion
            tombe dans la fenêtre : nouveau s’il a été créé dans la fenêtre, revenu sinon.
          </li>
          <li>
            Un dossier est un favori sur lequel le compte a posé un statut ou une enchère plafond,
            compté dans la fenêtre où il l’a fait. Les rappels envoyés viennent du journal des
            rappels (envois réussis seulement) ; les consentements actifs sont ceux qui existent à
            cet instant.
          </li>
          <li>
            Les événements ne sont enregistrés que depuis le début de la mesure
            {measuredSince ? ` (${formatDay(measuredSince)})` : ""}. Tant qu’une fenêtre commence
            avant, son chiffre est exact mais partiel, et la date est indiquée sous le nombre. Un
            même compte compte une fois par jour pour un même événement sur une même vente. Ils sont
            conservés 90 jours.
          </li>
          <li>
            « Plafonds d’enchère calculés » compte les ventes pour lesquelles la valeur de référence
            du plafond a été servie à un compte : le calcul du plafond se fait dans le navigateur. «
            Exports agenda » ne compte que les comptes connectés (le fichier est public).
          </li>
          <li>
            « Clics d’email » compte les ouvertures des liens suivis des alertes et des rappels. Une
            messagerie ou un antivirus qui ouvre le lien compte aussi : le chiffre est un maximum.
          </li>
        </ul>
      </AdminPanel>
    </>
  );
}

/** Fausses alertes des rappels d'audience : un rappel contredit par un changement de jour d'audience. */
function ReminderAccuracyCard({ accuracy }: { accuracy: SaleReminderAccuracy | null }) {
  const maxPercent = accuracy ? accuracy.maxRate * 100 : REMINDER_FALSE_ALERT_MAX_PERCENT;
  const minSample = accuracy ? accuracy.minimumSample : REMINDER_FALSE_ALERT_MIN_SAMPLE;
  const rate = formatReminderRate(accuracy);
  const measured = accuracy?.measuredReminders ?? null;
  const verdict = REMINDER_VERDICT_LABELS[accuracy?.verdict ?? "unavailable"];

  return (
    <AdminPanel className="mt-6 p-5">
      <AdminSectionHeading title="Fausses alertes des rappels" />
      <p className="mt-1 text-sm text-brand-navy/70">
        Un rappel d’audience (J-7 ou J-1) est une fausse alerte quand la date d’audience de la vente
        change vers un autre jour dans les 72 heures qui suivent son envoi. Mesure sur{" "}
        {accuracy?.windowDays ?? 30} jours glissants, parmi les rappels dont ces 72 heures sont
        écoulées.
      </p>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-brand-navy/70">Taux de fausses alertes</dt>
          <dd
            className={`tabular-nums ${
              rate === NOT_MEASURED ? "text-xs text-brand-navy/70" : "font-semibold"
            }`}
          >
            {rate}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-brand-navy/70">Rappels mesurés</dt>
          <dd
            className={`tabular-nums ${
              measured == null ? "text-xs text-brand-navy/70" : "font-semibold"
            }`}
          >
            {formatCount(measured)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 sm:col-span-2">
          <dt className="text-brand-navy/70">Verdict</dt>
          <dd className="text-right font-semibold">{verdict}</dd>
        </div>
      </dl>
      <p className="mt-3 text-sm leading-6 text-brand-navy/70">
        Critère de passage à « on » : moins de {formatInteger(maxPercent)} % de fausses alertes sur
        au moins {formatInteger(minSample)} rappels mesurés.
      </p>
    </AdminPanel>
  );
}

/** Les signaux dont la page lit les retours, avec leur libellé et leurs motifs (dans cet ordre). */
/**
 * Plafonds d'enchère calculés : l'indicateur d'usage de la fonction payante qui reste lisible pendant
 * l'offre de lancement, où « Déblocages de ventes » et « dont déblocages du mois » valent 0 faute de
 * déblocage consommé (tous les comptes ont alors l'accès Analyse).
 */
function BidCeilingCard({ summary }: { summary: BidCeilingSummary | null }) {
  const windows = [7, 30].map((days) => summary?.windows.find((window) => window.days === days));
  return (
    <AdminPanel className="mt-6 p-5">
      <AdminSectionHeading title="Plafonds calculés" />
      <p className="mt-1 text-sm text-brand-navy/70">
        Comptes ayant calculé au moins une enchère plafond et ventes concernées. Pendant l’offre de
        lancement, aucun déblocage n’est consommé : les lignes « Déblocages » ci-dessus valent 0 et
        ne disent rien de l’usage ; celle-ci, si. Administrateurs exclus.
      </p>
      <div className="mt-4 grid gap-6 sm:grid-cols-2">
        {[7, 30].map((days, index) => {
          const window = windows[index];
          const lines = [
            { label: "Comptes ayant calculé au moins un plafond", value: window?.accounts ?? null },
            { label: "Ventes concernées", value: window?.sales ?? null },
            {
              label: "Plafonds calculés (un par compte, vente et jour)",
              value: window?.occurrences ?? null,
            },
          ];
          return (
            <div key={days} data-window={days}>
              <h3 className="text-sm font-semibold text-brand-navy">{days} jours</h3>
              <dl className="mt-2 grid gap-y-1.5 text-sm">
                {lines.map((line) => (
                  <div key={line.label} className="flex items-baseline justify-between gap-3">
                    <dt className="text-brand-navy/70">{line.label}</dt>
                    <dd
                      className={`tabular-nums ${
                        line.value == null ? "text-xs text-brand-navy/70" : "font-semibold"
                      }`}
                    >
                      {formatCount(line.value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}
      </div>
    </AdminPanel>
  );
}

const FEEDBACK_SIGNALS: Array<{ signal: SaleSignal; label: string; reasons: string[] }> = [
  {
    signal: "market_gap_band",
    label: "Écart au marché (bande)",
    reasons: ["estimate_too_high", "estimate_too_low"],
  },
  {
    signal: "points_to_verify",
    label: "Points à vérifier",
    reasons: ["point_wrong", "point_missing"],
  },
];

/** Part d'« Utile » en pourcentage ; masquée sous le seuil d'affichage, « non mesuré » sans mesure. */
export function formatUsefulShare(counts: SignalFeedbackCounts | null): string {
  if (!counts || counts.total == null || counts.useful == null) return NOT_MEASURED;
  if (counts.total < PILOTAGE_MASK_BELOW) return MASKED;
  return `${Math.round((counts.useful / counts.total) * 100)} %`;
}

/**
 * Retours « Utile » / « Pas pertinent » des comptes sur la bande d'écart au marché et sur les points à
 * vérifier, sur 90 jours. Les « point faux » ont leur ligne ici : la page « Qualité » lit le rapport de
 * qualité du catalogue, elle n'a pas de file pour des retours de personnes.
 */
function SignalFeedbackCard({ summary }: { summary: SaleSignalFeedbackSummary | null }) {
  const lines = (signal: SaleSignal, reasons: string[]) => {
    const counts = summary?.signals[signal] ?? null;
    const share = formatUsefulShare(counts);
    return [
      {
        label: "Retours",
        text: formatCount(counts?.total ?? null),
        measured: counts?.total != null,
      },
      { label: "Part d’« Utile »", text: share, measured: share !== NOT_MEASURED },
      {
        label: "Comptes distincts",
        text: formatCount(counts?.accounts ?? null),
        measured: counts?.accounts != null,
      },
      ...reasons.map((reason) => ({
        label: SALE_SIGNAL_REASON_LABELS[reason as keyof typeof SALE_SIGNAL_REASON_LABELS],
        text: formatCount(counts?.reasons[reason] ?? null),
        measured: counts?.reasons[reason] != null,
      })),
    ];
  };
  return (
    <AdminPanel className="mt-6 p-5">
      <AdminSectionHeading title="Retours sur les signaux d’une vente" />
      <p className="mt-1 text-sm text-brand-navy/70">
        « Utile » ou « Pas pertinent », cliqué par un compte connecté sous la bande d’écart au
        marché ou sous la liste des points à vérifier, avec un motif choisi dans une liste (aucun
        texte libre). {summary?.windowDays ?? 90} derniers jours, administrateurs exclus.
      </p>
      <div className="mt-4 grid gap-6 sm:grid-cols-2">
        {FEEDBACK_SIGNALS.map(({ signal, label, reasons }) => (
          <div key={signal} data-signal={signal}>
            <h3 className="text-sm font-semibold text-brand-navy">{label}</h3>
            <dl className="mt-2 grid gap-y-1.5 text-sm">
              {lines(signal, reasons).map((line) => (
                <div key={line.label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-brand-navy/70">{line.label}</dt>
                  <dd
                    className={`tabular-nums ${
                      line.measured ? "font-semibold" : "text-xs text-brand-navy/70"
                    }`}
                  >
                    {line.text}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </AdminPanel>
  );
}
