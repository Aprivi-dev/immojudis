"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { AdminPanel, AdminShell } from "@/components/admin/AdminShell";
import { useAuth } from "@/hooks/use-auth";
import { Link } from "@/lib/router-compat";
import { fetchPipelineStatus, updatePipelineControl } from "@/lib/client-api";
import type { PipelineControlSettings, PipelineStatus } from "@/lib/pipeline-status";

const AdminPipelinePanel = dynamic(
  () => import("./AdminPipelinePanel").then((module) => module.AdminPipelinePanel),
  { loading: () => <LoadingPanel /> },
);
const AdminReadinessPanel = dynamic(
  () => import("./AdminReadinessPanel").then((module) => module.AdminReadinessPanel),
  { loading: () => <LoadingPanel /> },
);
const tabs = [
  { id: "automation", label: "Collecte & IA" },
  { id: "sources", label: "Sources de données" },
  { id: "services", label: "Services & diagnostics" },
] as const;

const shortcuts = [
  {
    href: "/admin/agent-ia",
    title: "Emails de l’agent IA",
    text: "Modifier les textes, prévisualiser et publier le modèle de prise de contact.",
    action: "Configurer les emails",
  },
  {
    href: "/admin/clients",
    title: "Accès & abonnements",
    text: "Consulter les abonnements et attribuer les plans disponibles aux clients.",
    action: "Gérer les accès",
  },
  {
    href: "/admin/lawyers",
    title: "Réseau d’avocats",
    text: "Gérer l’annuaire référencé et suivre les demandes de mise en relation.",
    action: "Gérer les avocats",
  },
  {
    href: "/admin/quality",
    title: "Qualité & estimations",
    text: "Contrôler les données et consulter les modèles d’estimation disponibles.",
    action: "Contrôler la qualité",
  },
  {
    href: "/admin/publications",
    title: "Modération des annonces",
    text: "Examiner les demandes de publication et décider de leur mise en ligne.",
    action: "Voir les publications",
  },
  {
    href: "/admin/compliance",
    title: "Confidentialité & conformité",
    text: "Traiter les demandes d’accès et de suppression, et suivre leurs échéances.",
    action: "Ouvrir la conformité",
  },
];

export function AdminSettingsPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<(typeof tabs)[number]["id"]>("automation");
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const preventNavigation = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      const anchor =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (
        !anchor ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download") ||
        (anchor.hash && anchor.pathname === window.location.pathname)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      toast.error("Enregistrez ou annulez vos modifications avant de quitter la configuration.");
    };
    window.addEventListener("beforeunload", preventUnload);
    document.addEventListener("click", preventNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", preventUnload);
      document.removeEventListener("click", preventNavigation, true);
    };
  }, [dirty]);
  return (
    <AdminShell
      activeSection="settings"
      title="Configuration"
      description="Réglez les automatismes et retrouvez tous les outils de gestion."
      adminEmail={user?.email}
    >
      <div className="space-y-6">
        <AdminPanel className="p-5 sm:p-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-[#a36f2c]">
            Centre de configuration
          </p>
          <h2 className="mt-2 text-xl font-semibold">Les bons réglages, au même endroit</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Les paramètres enregistrés ci-dessous s’appliquent au site. Chaque outil métier dispose
            de son propre écran de gestion. Les diagnostics indiquent les services à connecter ou à
            corriger.
          </p>
          <div
            className="mt-5 flex flex-wrap gap-2"
            role="tablist"
            aria-label="Catégories de configuration"
          >
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`tab-${item.id}`}
                aria-selected={tab === item.id}
                tabIndex={tab === item.id ? 0 : -1}
                onKeyDown={(event) => {
                  if (dirty || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
                    return;
                  event.preventDefault();
                  const index = tabs.findIndex((entry) => entry.id === item.id);
                  const nextIndex =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
                          tabs.length;
                  const next = tabs[nextIndex];
                  setTab(next.id);
                  document.getElementById(`tab-${next.id}`)?.focus();
                }}
                aria-controls={`panel-${item.id}`}
                disabled={dirty && tab !== item.id}
                onClick={() => setTab(item.id)}
                className={`${tab === item.id ? "admin-button-primary" : "admin-button-secondary"} disabled:opacity-50`}
              >
                {item.label}
              </button>
            ))}
          </div>
          {dirty ? (
            <p role="status" className="mt-3 text-sm text-amber-800">
              Enregistrez ou annulez vos modifications avant de changer de catégorie.
            </p>
          ) : null}
        </AdminPanel>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === "automation" ? <PipelineControls onDirtyChange={setDirty} /> : null}
          {tab === "sources" ? <AdminPipelinePanel /> : null}
          {tab === "services" ? (
            <>
              <AdminPanel className="p-5">
                <h2 className="font-semibold">Connexions et état des services</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Ce diagnostic vérifie les services du site. Les clés secrètes, les connexions de
                  paiement et les tâches planifiées se configurent dans l’environnement de
                  déploiement ; les indications ci-dessous précisent les actions nécessaires.
                </p>
              </AdminPanel>
              <AdminReadinessPanel />
            </>
          ) : null}
        </div>
        <section aria-labelledby="business-settings-title">
          <h2 id="business-settings-title" className="text-xl font-semibold">
            Gestion du site
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Accédez directement à chaque espace de configuration et de suivi.
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {shortcuts.map((item) => (
              <AdminPanel key={item.href} className="flex flex-col p-5">
                <h3 className="font-semibold">{item.title}</h3>
                <p className="mb-5 mt-2 flex-1 text-sm leading-6 text-slate-600">{item.text}</p>
                <Link to={item.href} className="admin-button-secondary justify-center">
                  {item.action}
                </Link>
              </AdminPanel>
            ))}
          </div>
        </section>
      </div>
    </AdminShell>
  );
}

function LoadingPanel() {
  return (
    <AdminPanel className="p-6">
      <p role="status" className="animate-pulse text-sm text-slate-600">
        Chargement des réglages…
      </p>
    </AdminPanel>
  );
}

function PipelineControls({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const client = useQueryClient();
  const [changes, setChanges] = useState<Partial<PipelineControlSettings>>({});
  const query = useQuery({
    queryKey: ["admin-pipeline"],
    queryFn: fetchPipelineStatus,
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const mutation = useMutation({
    mutationFn: () => updatePipelineControl(changes),
    onSuccess: async (control) => {
      client.setQueryData<PipelineStatus>(["admin-pipeline"], (previous) =>
        previous
          ? {
              ...previous,
              control: { ...previous.control, ...control },
              usage: { ...previous.usage, daily_ai_budget_usd: control.daily_ai_budget_usd },
            }
          : previous,
      );
      setChanges({});
      onDirtyChange(false);
      toast.success("Configuration enregistrée.");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["admin-pipeline"] }),
        client.invalidateQueries({ queryKey: ["admin-dashboard"] }),
      ]);
    },
    onError: () =>
      toast.error("La configuration n’a pas été enregistrée. Vos modifications sont conservées."),
  });
  if (query.isPending) return <LoadingPanel />;
  if (!query.data)
    return (
      <AdminPanel className="p-6">
        <p role="alert" className="text-sm text-red-700">
          Impossible de charger les réglages. {query.error?.message}
        </p>
        <button
          className="admin-button-secondary mt-4"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Réessayer
        </button>
      </AdminPanel>
    );
  const current = { ...query.data.control, ...changes };
  const dirty = Object.keys(changes).length > 0;
  const update = <K extends keyof PipelineControlSettings>(
    key: K,
    value: PipelineControlSettings[K],
  ) => {
    const next = { ...changes, [key]: value };
    if (value === query.data.control[key]) delete next[key];
    setChanges(next);
    onDirtyChange(Object.keys(next).length > 0);
    mutation.reset();
  };
  return (
    <AdminPanel className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Collecte automatique et consommation IA</h2>
          <p className="mt-2 text-sm text-slate-600">
            Ces limites concernent les traitements automatiques planifiés.
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${query.data.control.enabled ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}
        >
          {query.data.control.enabled ? "Planification active" : "Planification suspendue"}
        </span>
      </div>
      {query.error ? (
        <p role="alert" className="mt-4 text-sm text-amber-800">
          Actualisation impossible. Les derniers réglages reçus restent affichés.
        </p>
      ) : null}
      <form
        className="mt-6 space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty && !mutation.isPending) mutation.mutate();
        }}
      >
        <fieldset disabled={mutation.isPending} className="space-y-5 disabled:opacity-60">
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4">
            <input
              className="mt-1 size-4 accent-[#a36f2c]"
              type="checkbox"
              checked={current.enabled}
              onChange={(event) => update("enabled", event.target.checked)}
            />
            <span>
              <span className="block font-medium">Activer la planification automatique</span>
              <span className="mt-1 block text-sm leading-6 text-slate-600">
                Autorise les prochains départs de collecte et d’enrichissement. Une suspension
                laisse les lots déjà lancés se terminer. Le planificateur doit être connecté dans
                les services.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4">
            <input
              className="mt-1 size-4 accent-[#a36f2c]"
              type="checkbox"
              checked={current.source_details_enabled}
              onChange={(event) => update("source_details_enabled", event.target.checked)}
            />
            <span>
              <span className="block font-medium">
                Actualiser les fiches détaillées des sources
              </span>
              <span className="mt-1 block text-sm leading-6 text-slate-600">
                Autorise les traitements récurrents de détail lorsque la planification est active.
                Les suspensions propres à chaque source restent respectées.
              </span>
            </span>
          </label>
          <div className="grid gap-5 md:grid-cols-2">
            <label className="block">
              <span id="budget-label" className="block text-sm font-semibold">
                Budget IA quotidien (USD)
              </span>
              <input
                className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900"
                type="number"
                min="0"
                max="10000"
                step="0.01"
                required
                value={Number.isNaN(current.daily_ai_budget_usd) ? "" : current.daily_ai_budget_usd}
                onChange={(event) => update("daily_ai_budget_usd", event.target.valueAsNumber)}
                aria-labelledby="budget-label"
                aria-describedby="budget-help"
              />
              <span id="budget-help" className="mt-2 block text-sm leading-6 text-slate-600">
                Plafond par jour UTC, tenant compte des réservations des appels en cours. 0 bloque
                les nouveaux appels IA automatiques. Ce plafond ne couvre pas les lancements
                manuels.
              </span>
            </label>
            <label className="block">
              <span id="calls-label" className="block text-sm font-semibold">
                Appels IA maximum par exécution
              </span>
              <input
                className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900"
                type="number"
                min="1"
                max="100"
                step="1"
                required
                value={
                  Number.isNaN(current.max_ai_predictions_per_run)
                    ? ""
                    : current.max_ai_predictions_per_run
                }
                onChange={(event) =>
                  update("max_ai_predictions_per_run", event.target.valueAsNumber)
                }
                aria-labelledby="calls-label"
                aria-describedby="calls-help"
              />
              <span id="calls-help" className="mt-2 block text-sm leading-6 text-slate-600">
                De 1 à 100 appels. Les tâches restantes attendent une prochaine exécution. Le budget
                quotidien reste prioritaire.
              </span>
            </label>
          </div>
        </fieldset>
        {mutation.error ? (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {mutation.error.message}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-5">
          <button
            type="submit"
            className="admin-button-primary disabled:opacity-50"
            disabled={!dirty || mutation.isPending}
          >
            {mutation.isPending ? "Enregistrement…" : "Enregistrer les réglages"}
          </button>
          <button
            type="button"
            className="admin-button-secondary disabled:opacity-50"
            disabled={!dirty || mutation.isPending}
            onClick={() => {
              setChanges({});
              onDirtyChange(false);
              mutation.reset();
            }}
          >
            Annuler les modifications
          </button>
          <span role="status" className="text-sm text-slate-600">
            {dirty ? "Modifications non enregistrées" : "Réglages enregistrés"}
          </span>
        </div>
      </form>
    </AdminPanel>
  );
}
