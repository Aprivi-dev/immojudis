import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { amIAdmin, listAllProfiles, setUserApproval } from "@/lib/profile.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/admin")({
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) {
      throw redirect({ to: "/login", search: { redirect: "/admin" } });
    }
  },
  component: AdminPage,
});

function AdminPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const checkAdmin = useServerFn(amIAdmin);
  const fetchProfiles = useServerFn(listAllProfiles);
  const approveFn = useServerFn(setUserApproval);

  const adminQ = useQuery({ queryKey: ["am-i-admin"], queryFn: () => checkAdmin() });
  const profilesQ = useQuery({
    queryKey: ["all-profiles"],
    queryFn: () => fetchProfiles(),
    enabled: adminQ.data?.isAdmin === true,
  });

  const mutation = useMutation({
    mutationFn: (vars: { userId: string; approve: boolean }) =>
      approveFn({ data: vars }),
    onSuccess: (_d, vars) => {
      toast.success(vars.approve ? "Utilisateur approuvé" : "Accès révoqué");
      qc.invalidateQueries({ queryKey: ["all-profiles"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (adminQ.isLoading) {
    return <div className="mx-auto max-w-5xl px-6 py-12 text-muted-foreground">Chargement…</div>;
  }

  if (!adminQ.data?.isAdmin) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="font-display text-3xl">Accès refusé</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Cette page est réservée aux administrateurs.
        </p>
        <button
          onClick={() => router.navigate({ to: "/" })}
          className="mt-6 border border-[var(--gold)] px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--gold)] hover:bg-[var(--gold)] hover:text-[var(--background)]"
        >
          Retour
        </button>
      </div>
    );
  }

  const profiles = profilesQ.data ?? [];
  const pending = profiles.filter((p) => !p.is_approved);
  const approved = profiles.filter((p) => p.is_approved);

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="font-display text-3xl font-bold">Administration</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Gérez les accès des utilisateurs.
      </p>

      <Section title={`En attente (${pending.length})`}>
        {pending.length === 0 ? (
          <Empty>Aucune demande en attente.</Empty>
        ) : (
          <Table
            rows={pending}
            actionLabel="Approuver"
            actionClass="bg-[var(--gold)] text-[var(--background)] hover:opacity-90"
            onAction={(uid) => mutation.mutate({ userId: uid, approve: true })}
            busy={mutation.isPending}
          />
        )}
      </Section>

      <Section title={`Approuvés (${approved.length})`}>
        {approved.length === 0 ? (
          <Empty>Aucun utilisateur approuvé.</Empty>
        ) : (
          <Table
            rows={approved}
            actionLabel="Révoquer"
            actionClass="border border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground"
            onAction={(uid) => mutation.mutate({ userId: uid, approve: false })}
            busy={mutation.isPending}
          />
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        {title}
      </h2>
      <div className="border border-white/10">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="p-6 text-sm text-muted-foreground">{children}</div>;
}

type Row = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  created_at: string;
  approved_at: string | null;
};

function Table({
  rows,
  actionLabel,
  actionClass,
  onAction,
  busy,
}: {
  rows: Row[];
  actionLabel: string;
  actionClass: string;
  onAction: (userId: string) => void;
  busy: boolean;
}) {
  return (
    <div className="divide-y divide-white/10">
      {rows.map((r) => (
        <div key={r.user_id} className="flex flex-wrap items-center gap-4 p-4">
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{r.display_name ?? "—"}</div>
            <div className="truncate text-sm text-muted-foreground">{r.email}</div>
          </div>
          <div className="text-xs text-muted-foreground">
            Inscrit le {new Date(r.created_at).toLocaleDateString("fr-FR")}
          </div>
          <button
            disabled={busy}
            onClick={() => onAction(r.user_id)}
            className={`px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] disabled:opacity-50 ${actionClass}`}
          >
            {actionLabel}
          </button>
        </div>
      ))}
    </div>
  );
}