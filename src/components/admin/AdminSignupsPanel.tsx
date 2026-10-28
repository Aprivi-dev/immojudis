"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CalendarPlus from "lucide-react/dist/esm/icons/calendar-plus.js";
import Clock from "lucide-react/dist/esm/icons/clock.js";
import MailCheck from "lucide-react/dist/esm/icons/mail-check.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
import UserPlus from "lucide-react/dist/esm/icons/user-plus.js";
import Users from "lucide-react/dist/esm/icons/users.js";
import { useEffect, useState } from "react";
import { AdminPagination } from "@/components/admin/AdminPagination";
import { AdminPanel, AdminSectionHeading } from "@/components/admin/AdminShell";
import { formatInteger } from "@/components/admin/admin-format";
import { AdminQueryErrorNotice, OverviewMetric } from "@/components/admin/admin-ui";
import { ANALYSIS_TRIAL_DAYS } from "@/lib/analysis-offer";
import { extendAdminSignupTrials, fetchAdminSignups } from "@/lib/client-api/admin-signups";
import { dateTimeLocalToUtcIso, formatDateTimeLocalInput } from "@/lib/admin-subscription-datetime";
import { TRIAL_EXTENSION_MAX_ACCOUNTS, TRIAL_EXTENSION_MAX_DAYS } from "@/lib/admin-signups-format";
import {
  ADMIN_SIGNUP_ACCESS,
  ADMIN_SIGNUP_ACCESS_LABELS,
  endOfDayInDays,
  formatAccountSeniority,
  type AdminSignupAccess,
} from "@/lib/admin-signups-format";
import type { AdminSignupAccount, AdminTrialExtensionResponse } from "@/lib/admin-signups";
import { toast } from "@/lib/toast";

export const SIGNUPS_QUERY_KEY = ["admin-signups"] as const;

const PAGE_SIZE = 50;
const EXTENSION_SHORTCUTS = [7, 14, 30] as const;

type AccessFilter = "all" | AdminSignupAccess;
type ActivityFilter = "all" | "trial_ended_idle";

/**
 * Liste des comptes inscrits (gratuits compris) : date d'inscription, ancienneté, confirmation de
 * l'adresse, dernière connexion et accès en cours. Les comptes cochés peuvent voir leur essai
 * prolongé jusqu'à une date choisie (accès Analyse « Essai » qui se ferme seul à cette date).
 */
export function AdminSignupsPanel() {
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [access, setAccess] = useState<AccessFilter>("all");
  const [activity, setActivity] = useState<ActivityFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [endsAt, setEndsAt] = useState(() => formatDateTimeLocalInput(endOfDayInDays(14)));
  const [note, setNote] = useState("");
  const [lastResult, setLastResult] = useState<AdminTrialExtensionResponse | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useQuery({
    queryKey: [...SIGNUPS_QUERY_KEY, offset, debouncedSearch, access, activity],
    queryFn: () =>
      fetchAdminSignups({ offset, limit: PAGE_SIZE, q: debouncedSearch, access, activity }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const data = query.data;
  const accounts = data?.accounts ?? [];

  const extension = useMutation({
    mutationFn: () => {
      const iso = dateTimeLocalToUtcIso(endsAt);
      if (!iso) throw new Error("Choisissez une date de fin valide.");
      if (selected.size > TRIAL_EXTENSION_MAX_ACCOUNTS) {
        throw new Error(`Une prolongation vise ${TRIAL_EXTENSION_MAX_ACCOUNTS} comptes au plus.`);
      }
      if (note.trim().length < 3) throw new Error("Indiquez le motif de la prolongation.");
      return extendAdminSignupTrials({ userIds: [...selected], endsAt: iso, note });
    },
    onSuccess: async (response) => {
      const extended = response.results.filter((result) => result.outcome === "extended").length;
      const skipped = response.results.length - extended;
      setLastResult(response);
      if (extended) {
        toast.success(
          `Essai prolongé pour ${extended} compte${extended > 1 ? "s" : ""} jusqu’au ${formatDate(response.endsAt)}.`,
        );
      }
      if (skipped)
        toast.error(
          `${skipped} compte${skipped > 1 ? "s" : ""} non prolongé${skipped > 1 ? "s" : ""}.`,
        );
      setSelected(new Set());
      setNote("");
      await queryClient.invalidateQueries({ queryKey: SIGNUPS_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ["admin-subscriptions"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Prolongation impossible");
    },
  });

  const selectable = accounts.filter((account) => account.extendable);
  const allPageSelected =
    selectable.length > 0 && selectable.every((account) => selected.has(account.userId));

  function toggle(userId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  function togglePage() {
    setSelected((current) => {
      const next = new Set(current);
      for (const account of selectable) {
        if (allPageSelected) next.delete(account.userId);
        else next.add(account.userId);
      }
      return next;
    });
  }

  const summary = data?.summary;
  const inTrial = summary ? summary.byAccess.trial + summary.byAccess.trial_extended : null;
  const analysis = summary
    ? summary.byAccess.analyse_paid + summary.byAccess.analyse_manual + summary.byAccess.premium
    : null;

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <AdminPanel>
          <OverviewMetric
            icon={<Users />}
            value={summary ? formatInteger(summary.total) : "—"}
            label="Comptes inscrits (hors administrateurs)"
          />
        </AdminPanel>
        <AdminPanel>
          <OverviewMetric
            icon={<MailCheck />}
            tone="green"
            value={summary ? formatInteger(summary.confirmed) : "—"}
            label="Adresses email confirmées"
          />
        </AdminPanel>
        <AdminPanel>
          <OverviewMetric
            icon={<UserPlus />}
            value={
              summary
                ? `${formatInteger(summary.last7Days)} · ${formatInteger(summary.last30Days)}`
                : "—"
            }
            label="Nouveaux sur 7 jours · sur 30 jours"
          />
        </AdminPanel>
        <AdminPanel>
          <OverviewMetric
            icon={<Clock />}
            tone="copper"
            value={inTrial == null ? "—" : formatInteger(inTrial)}
            label={`En essai (${ANALYSIS_TRIAL_DAYS} jours ou prolongé)`}
          />
        </AdminPanel>
        <AdminPanel>
          <OverviewMetric
            icon={<Sparkles />}
            tone="green"
            value={analysis == null ? "—" : formatInteger(analysis)}
            label="Accès Analyse ou premium"
          />
        </AdminPanel>
        <AdminPanel>
          <OverviewMetric
            icon={<Users />}
            value={summary ? formatInteger(summary.byAccess.decouverte) : "—"}
            label="En Découverte (gratuit)"
          />
        </AdminPanel>
      </div>

      <AdminPanel className="p-5">
        <AdminSectionHeading
          title="Comptes inscrits"
          description="Du plus récent au plus ancien. Cochez des comptes pour prolonger leur essai gratuit."
        />

        {data && !data.launchOfferActive ? (
          <p className="mt-4 rounded-lg border border-warning/25 bg-warning-tint p-3 text-sm text-warning">
            L’essai gratuit à l’inscription est coupé : les comptes qui confirment leur adresse
            maintenant n’ont pas d’essai. Ceux confirmés avant la coupure gardent leurs{" "}
            {ANALYSIS_TRIAL_DAYS} jours, et une prolongation reste active jusqu’à sa date.
          </p>
        ) : null}
        {data?.truncated ? (
          <p className="mt-4 rounded-lg border border-warning/25 bg-warning-tint p-3 text-sm text-warning">
            Liste incomplète : seuls les 20 000 premiers comptes ont été lus.
          </p>
        ) : null}

        <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-end">
          <label className="grid flex-1 gap-1.5 text-sm font-medium text-brand-navy/80">
            Rechercher un email ou un nom
            <input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setOffset(0);
              }}
              placeholder="prenom@exemple.fr"
              className="rounded-lg border border-brand-navy/55 bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-brand-navy/80">
            Type d’accès
            <select
              value={access}
              onChange={(event) => {
                setAccess(event.target.value as AccessFilter);
                setOffset(0);
              }}
              className="rounded-lg border border-brand-navy/55 bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
            >
              <option value="all">Tous{summary ? ` (${summary.total})` : ""}</option>
              {ADMIN_SIGNUP_ACCESS.map((value) => (
                <option key={value} value={value}>
                  {ADMIN_SIGNUP_ACCESS_LABELS[value]}
                  {summary ? ` (${summary.byAccess[value]})` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium text-brand-navy/80">
            Activité
            <select
              value={activity}
              onChange={(event) => {
                setActivity(event.target.value as ActivityFilter);
                setOffset(0);
              }}
              className="rounded-lg border border-brand-navy/55 bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
            >
              <option value="all">Toutes</option>
              <option value="trial_ended_idle">
                Essai fini sans activité
                {summary?.trialEndedIdle != null ? ` (${summary.trialEndedIdle})` : ""}
              </option>
            </select>
          </label>
        </div>
        {data && !data.usageAvailable ? (
          <p className="mt-3 text-xs text-brand-navy/70">
            Usage par compte non mesuré (migration non appliquée ou lecture impossible) : le filtre
            « essai fini sans activité » ne rend rien.
          </p>
        ) : null}

        {selected.size > 0 ? (
          <form
            className="mt-4 grid gap-3 rounded-lg border border-gold/40 bg-gold/[0.06] p-4"
            aria-label="Prolonger l’essai des comptes sélectionnés"
            onSubmit={(event) => {
              event.preventDefault();
              extension.mutate();
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-sm text-brand-navy">
                {selected.size} compte{selected.size > 1 ? "s" : ""} sélectionné
                {selected.size > 1 ? "s" : ""}
              </strong>
              <button
                type="button"
                className="text-sm text-brand-navy/70 underline"
                onClick={() => setSelected(new Set())}
              >
                Tout désélectionner
              </button>
            </div>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
              <label className="grid gap-1.5 text-sm font-medium text-brand-navy/80">
                Essai prolongé jusqu’au
                <input
                  type="datetime-local"
                  required
                  value={endsAt}
                  onChange={(event) => setEndsAt(event.target.value)}
                  className="rounded-lg border border-brand-navy/55 bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
                />
              </label>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Raccourcis de durée">
                {EXTENSION_SHORTCUTS.map((days) => (
                  <button
                    key={days}
                    type="button"
                    className="admin-button-secondary"
                    onClick={() => setEndsAt(formatDateTimeLocalInput(endOfDayInDays(days)))}
                  >
                    + {days} jours
                  </button>
                ))}
              </div>
              <label className="grid flex-1 gap-1.5 text-sm font-medium text-brand-navy/80">
                Motif (obligatoire, gardé en privé)
                <input
                  type="text"
                  required
                  minLength={3}
                  maxLength={500}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Ex. : demande reçue par email, retour d’expérience promis"
                  className="rounded-lg border border-brand-navy/55 bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
                />
              </label>
              <button
                type="submit"
                disabled={extension.isPending || selected.size > TRIAL_EXTENSION_MAX_ACCOUNTS}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-gold-soft px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-gold-text disabled:cursor-not-allowed disabled:opacity-60"
              >
                <CalendarPlus className="size-4" />
                {extension.isPending ? "Prolongation…" : "Prolonger l’essai"}
              </button>
            </div>
            <p className="text-xs text-brand-navy/62">
              Les comptes gardent l’accès Analyse jusqu’à cette date, puis reviennent seuls en
              Découverte ; rien ne devient payant. Au plus {TRIAL_EXTENSION_MAX_ACCOUNTS} comptes et{" "}
              {TRIAL_EXTENSION_MAX_DAYS} jours par prolongation. Un accès déjà plus long, une fin
              antérieure à celle de l’essai, un compte non confirmé, un compte premium ou un abonné
              Stripe ne sont jamais prolongés. Le motif n’est pas visible par la personne.
            </p>
          </form>
        ) : null}

        {lastResult && lastResult.results.some((result) => result.outcome === "skipped") ? (
          <div className="mt-4 rounded-lg border border-warning/25 bg-warning-tint p-3 text-sm text-warning">
            <p className="font-semibold">Comptes non prolongés :</p>
            <ul className="mt-1 list-disc pl-5">
              {lastResult.results
                .filter((result) => result.outcome === "skipped")
                .map((result) => (
                  <li key={result.userId}>
                    {result.email ?? result.userId} — {result.reason}
                  </li>
                ))}
            </ul>
          </div>
        ) : null}

        {query.error ? (
          <AdminQueryErrorNotice
            className="mt-4"
            error={query.error}
            fallback="Chargement des inscriptions impossible"
            hasData={Boolean(data)}
            isRetrying={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        ) : null}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[64rem] text-left text-sm">
            <caption className="sr-only">Comptes inscrits sur Immojudis</caption>
            <thead>
              <tr className="border-b border-brand-navy/12 text-xs uppercase text-brand-navy/70">
                <th scope="col" className="w-10 px-2 py-2">
                  <input
                    type="checkbox"
                    aria-label="Sélectionner les comptes de la page"
                    checked={allPageSelected}
                    disabled={selectable.length === 0}
                    onChange={togglePage}
                  />
                </th>
                <th scope="col" className="px-2 py-2 font-semibold">
                  Compte
                </th>
                <th scope="col" className="px-2 py-2 font-semibold">
                  Inscription
                </th>
                <th scope="col" className="px-2 py-2 font-semibold">
                  Ancienneté
                </th>
                <th scope="col" className="px-2 py-2 font-semibold">
                  Dernière connexion
                </th>
                <th scope="col" className="px-2 py-2 font-semibold">
                  Accès
                </th>
                <th scope="col" className="px-2 py-2 font-semibold">
                  Déblocages
                </th>
                <th scope="col" className="px-2 py-2 font-semibold">
                  Plafonds
                </th>
                <th scope="col" className="px-2 py-2 font-semibold">
                  Favoris
                </th>
                <th scope="col" className="px-2 py-2 font-semibold">
                  Fiches
                </th>
              </tr>
            </thead>
            <tbody>
              {query.isLoading ? (
                <tr>
                  <td colSpan={10} className="px-2 py-6 text-center text-ink-soft">
                    <span role="status">Chargement des inscriptions…</span>
                  </td>
                </tr>
              ) : accounts.length ? (
                accounts.map((account) => (
                  <SignupRow
                    key={account.userId}
                    account={account}
                    checked={selected.has(account.userId)}
                    onToggle={() => toggle(account.userId)}
                  />
                ))
              ) : (
                <tr>
                  <td colSpan={10} className="px-2 py-6 text-center text-ink-soft">
                    Aucun compte ne correspond.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminPanel>

      {data ? (
        <AdminPagination
          label="comptes inscrits"
          offset={offset}
          limit={PAGE_SIZE}
          total={data.filteredCount}
          shown={accounts.length}
          busy={query.isFetching}
          onOffsetChange={setOffset}
        />
      ) : null}
    </div>
  );
}

function SignupRow({
  account,
  checked,
  onToggle,
}: {
  account: AdminSignupAccount;
  checked: boolean;
  onToggle: () => void;
}) {
  const label = account.email ?? account.userId;
  return (
    <tr className="border-b border-brand-navy/8 align-top">
      <td className="px-2 py-3">
        <input
          type="checkbox"
          aria-label={`Sélectionner ${label}`}
          checked={checked}
          disabled={!account.extendable}
          title={account.extendable ? undefined : "Compte premium ou abonnement Stripe en cours"}
          onChange={onToggle}
        />
      </td>
      <th scope="row" className="max-w-[18rem] px-2 py-3 font-normal">
        <span className="block truncate font-semibold text-brand-navy">{label}</span>
        <span className="mt-0.5 block truncate text-xs text-brand-navy/62">
          {[
            account.fullName,
            account.accountType === "b2b"
              ? "Professionnel"
              : account.accountType === "b2c"
                ? "Particulier"
                : null,
            account.emailConfirmedAt ? null : "email non confirmé",
          ]
            .filter(Boolean)
            .join(" · ") || "—"}
        </span>
      </th>
      <td className="px-2 py-3 tabular-nums">{formatDateTime(account.createdAt)}</td>
      <td className="px-2 py-3">{formatAccountSeniority(account.createdAt)}</td>
      <td className="px-2 py-3 tabular-nums">
        {account.lastSignInAt ? formatDateTime(account.lastSignInAt) : "Jamais"}
      </td>
      <td className="px-2 py-3">
        <AccessPill access={account.access} />
        <span className="mt-1 block text-xs text-brand-navy/62">{accessDetail(account)}</span>
      </td>
      <UsageCell value={account.usage?.unlocks} />
      <UsageCell value={account.usage?.ceilings} />
      <UsageCell value={account.usage?.favorites} />
      <UsageCell value={account.usage?.sheetsServed} />
    </tr>
  );
}

/** Un nombre d'usage ; « non mesuré » quand la lecture d'usage n'est pas disponible. */
function UsageCell({ value }: { value: number | undefined }) {
  return (
    <td className="px-2 py-3 tabular-nums">
      {value == null ? <span className="text-xs text-brand-navy/62">non mesuré</span> : value}
    </td>
  );
}

function AccessPill({ access }: { access: AdminSignupAccess }) {
  const tone =
    access === "decouverte"
      ? "border-brand-navy/15 bg-brand-navy/[0.04] text-brand-navy/75"
      : access === "trial" || access === "trial_extended"
        ? "border-warning/25 bg-warning-tint text-warning"
        : "border-success/25 bg-success-tint text-success";
  return (
    <span className={`inline-flex w-fit rounded-full border px-2.5 py-0.5 text-xs ${tone}`}>
      {ADMIN_SIGNUP_ACCESS_LABELS[access]}
    </span>
  );
}

function accessDetail(account: AdminSignupAccount): string {
  if (account.access === "premium") return "Accès complet sans fin";
  if (account.access !== "decouverte") {
    return account.accessEndsAt
      ? `jusqu’au ${formatDate(account.accessEndsAt)}`
      : "sans date de fin";
  }
  if (!account.emailConfirmedAt) return "Essai à la confirmation de l’email";
  if (account.trialEndsAt && Date.parse(account.trialEndsAt) <= Date.now()) {
    return `Essai terminé le ${formatDate(account.trialEndsAt)}`;
  }
  if (account.trialEndsAt) return "Sans essai (adresse confirmée après la coupure de l’essai)";
  return "Sans essai (adresse déjà utilisée ou jetable)";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
