"use client";

import { useQuery } from "@tanstack/react-query";
import { AdminPanel, AdminSectionHeading, AdminShell } from "@/components/admin/AdminShell";
import { formatDateTime, formatInteger, queryErrorMessage } from "@/components/admin/admin-format";
import { AdminPanelLoading, useAdminRefresh } from "@/components/admin/admin-ui";
import { useAuth } from "@/hooks/use-auth";
import type { AdminPilotage, PilotageCount, PilotageWindow } from "@/lib/admin-pilotage";
import { fetchAdminPilotage } from "@/lib/client-api/admin";

export const PILOTAGE_QUERY_KEY = ["admin-pilotage"] as const;

/** Libellé d'un chiffre absent : jamais un zéro à la place. */
export const NOT_MEASURED = "non mesuré";

type Row = {
  label: string;
  value: (window: PilotageWindow) => PilotageCount;
  /** Ligne de détail d'une ligne précédente (retrait à gauche). */
  detail?: boolean;
  /** Les événements n'existent que depuis le début de la mesure. */
  event?: boolean;
};

type Section = { title: string; rows: Row[] };

const SECTIONS: Section[] = [
  {
    title: "Comptes",
    rows: [
      { label: "Inscriptions (comptes créés)", value: (w) => w.signups },
      { label: "Comptes actifs (au moins une connexion)", value: (w) => w.activeAccounts },
    ],
  },
  {
    title: "Parcours (événements enregistrés par compte)",
    rows: [
      { label: "Déblocages de ventes", value: (w) => w.events.unlocks, event: true },
      { label: "Quotas atteints", value: (w) => w.events.quotaReached.total, event: true },
      {
        label: "dont déblocages du mois",
        value: (w) => w.events.quotaReached.unlocks,
        detail: true,
        event: true,
      },
      {
        label: "dont favoris",
        value: (w) => w.events.quotaReached.favorites,
        detail: true,
        event: true,
      },
      {
        label: "dont plafonds quotidiens",
        value: (w) => w.events.quotaReached.daily,
        detail: true,
        event: true,
      },
      { label: "Plafonds d’enchère calculés", value: (w) => w.events.bidCeilings, event: true },
      { label: "Exports agenda (.ics)", value: (w) => w.events.calendarExports, event: true },
      { label: "Clics d’email", value: (w) => w.events.emailClicks.total, event: true },
      {
        label: "dont alertes",
        value: (w) => w.events.emailClicks.alert,
        detail: true,
        event: true,
      },
      {
        label: "dont rappels d’audience",
        value: (w) => w.events.emailClicks.reminder,
        detail: true,
        event: true,
      },
    ],
  },
  {
    title: "Alertes",
    rows: [{ label: "Alertes créées", value: (w) => w.alertsCreated }],
  },
  {
    title: "Intérêt pour l’offre Analyse (liste d’attente)",
    rows: [{ label: "Demandes « Me prévenir de l’ouverture »", value: (w) => w.waitlistRequests }],
  },
];

function formatCount(value: PilotageCount): string {
  return value == null ? NOT_MEASURED : formatInteger(value);
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

function PilotageTables({ data }: { data: AdminPilotage }) {
  const windows = [...data.windows].sort((a, b) => a.days - b.days);
  const measuredSince = data.eventsMeasuredSince;

  return (
    <>
      <AdminPanel className="p-5">
        <AdminSectionHeading
          title="Agrégats sur 7 et 30 jours glissants"
          description={
            data.generatedAt
              ? `Calculés le ${formatDateTime(data.generatedAt)}. Une donnée absente s’affiche « ${NOT_MEASURED} », jamais zéro.`
              : `Une donnée absente s’affiche « ${NOT_MEASURED} », jamais zéro.`
          }
        />
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-sm">
            <caption className="sr-only">Chiffres de pilotage sur 7 et 30 jours glissants</caption>
            <thead>
              <tr className="border-b border-brand-navy/12 text-xs uppercase tracking-[0.08em] text-brand-navy/62">
                <th scope="col" className="py-2 pr-4 font-semibold">
                  Mesure
                </th>
                {windows.map((window) => (
                  <th key={window.days} scope="col" className="px-3 py-2 text-right font-semibold">
                    {window.days} jours
                  </th>
                ))}
              </tr>
            </thead>
            {SECTIONS.map((section) => (
              <tbody key={section.title}>
                <tr>
                  <th
                    scope="rowgroup"
                    colSpan={1 + windows.length}
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
                        row.detail ? "pl-5 text-brand-navy/62" : "font-medium"
                      }`}
                    >
                      {row.label}
                    </th>
                    {windows.map((window) => {
                      const value = row.value(window);
                      const partial =
                        row.event && value != null && !window.eventsComplete && measuredSince;
                      return (
                        <td key={window.days} className="px-3 py-2 text-right tabular-nums">
                          <span
                            className={
                              value == null ? "text-xs italic text-brand-navy/55" : "font-semibold"
                            }
                          >
                            {formatCount(value)}
                          </span>
                          {partial ? (
                            <span className="block text-xs font-normal text-brand-navy/55">
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
        <p className="mt-4 text-sm text-brand-navy/70">
          Demandes de liste d’attente actives à cet instant :{" "}
          <strong className="tabular-nums">{formatCount(data.waitlistActive)}</strong>
        </p>
      </AdminPanel>

      <AdminPanel className="mt-6 p-5">
        <AdminSectionHeading title="Comment lire ces chiffres" />
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-brand-navy/72">
          <li>
            Les fenêtres sont glissantes (7 ou 30 jours avant le calcul). Tous les comptes sont
            comptés, administrateurs compris. Aucun nom, aucune adresse : des nombres seulement.
          </li>
          <li>
            Inscriptions et alertes sont celles qui existent encore : un compte ou une alerte
            supprimé depuis n’est plus compté. Un compte actif est un compte dont la dernière
            connexion tombe dans la fenêtre ; une session restée ouverte sans nouvelle connexion n’y
            figure pas.
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
