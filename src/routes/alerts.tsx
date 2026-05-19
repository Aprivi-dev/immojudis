import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Trash2, Bell, Power } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { getAlerts, createAlert, updateAlert, deleteAlert } from "@/lib/queries";
import type { UserAlert } from "@/lib/types";

export const Route = createFileRoute("/alerts")({
  component: AlertsPage,
});

function AlertsPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState<UserAlert[]>([]);
  const [form, setForm] = useState({
    name: "",
    department: "",
    property_type: "",
    max_price_eur: "",
    min_investment_score: "",
    occupancy_status: "",
  });

  useEffect(() => {
    if (loading) return;
    if (!user) { navigate({ to: "/login" }); return; }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, loading]);

  async function refresh() {
    if (!user) return;
    setAlerts(await getAlerts(user.id));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (!form.name.trim()) { toast.error("Nom requis"); return; }
    try {
      await createAlert(user.id, {
        name: form.name.trim(),
        department: form.department || null,
        city: null,
        property_type: form.property_type || null,
        max_price_eur: form.max_price_eur ? Number(form.max_price_eur) : null,
        min_surface_m2: null,
        occupancy_status: form.occupancy_status || null,
        min_investment_score: form.min_investment_score ? Number(form.min_investment_score) : null,
      });
      toast.success("Alerte créée");
      setForm({ name: "", department: "", property_type: "", max_price_eur: "", min_investment_score: "", occupancy_status: "" });
      refresh();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  }

  async function toggle(a: UserAlert) {
    if (!user) return;
    await updateAlert(user.id, a.id, { is_active: !a.is_active });
    refresh();
  }

  async function remove(a: UserAlert) {
    if (!user) return;
    if (!confirm(`Supprimer l'alerte "${a.name}" ?`)) return;
    await deleteAlert(user.id, a.id);
    toast.success("Alerte supprimée");
    refresh();
  }

  if (loading || !user) return <main className="mx-auto max-w-5xl px-4 py-10 text-muted-foreground">Chargement…</main>;

  const cls = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="text-2xl font-bold text-foreground">Mes alertes</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Créez des alertes pour suivre les annonces qui correspondent à vos critères. Les notifications arrivent dans une prochaine version.
      </p>

      <form onSubmit={submit} className="mt-6 rounded-lg border border-border bg-card p-5">
        <h2 className="text-base font-semibold">Nouvelle alerte</h2>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <input className={cls} placeholder="Nom de l'alerte *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className={cls} placeholder="Département (ex: 33)" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
          <select className={cls} value={form.property_type} onChange={(e) => setForm({ ...form, property_type: e.target.value })}>
            <option value="">Type de bien</option>
            <option value="apartment">Appartement</option>
            <option value="house">Maison</option>
            <option value="land">Terrain</option>
            <option value="commercial">Commercial</option>
          </select>
          <input className={cls} type="number" placeholder="Prix max (€)" value={form.max_price_eur} onChange={(e) => setForm({ ...form, max_price_eur: e.target.value })} />
          <input className={cls} type="number" placeholder="Score min" value={form.min_investment_score} onChange={(e) => setForm({ ...form, min_investment_score: e.target.value })} />
          <select className={cls} value={form.occupancy_status} onChange={(e) => setForm({ ...form, occupancy_status: e.target.value })}>
            <option value="">Occupation</option>
            <option value="free">Libre</option>
            <option value="occupied">Occupé</option>
            <option value="rented">Loué</option>
          </select>
        </div>
        <button type="submit" className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          <Bell className="h-4 w-4" /> Créer l'alerte
        </button>
      </form>

      <div className="mt-8">
        <h2 className="text-base font-semibold text-foreground">Alertes existantes ({alerts.length})</h2>
        <div className="mt-3 space-y-2">
          {alerts.length === 0 && (
            <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              Aucune alerte créée.
            </p>
          )}
          {alerts.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-foreground">{a.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {[
                    a.department && `Dép. ${a.department}`,
                    a.property_type,
                    a.max_price_eur != null && `≤ ${a.max_price_eur.toLocaleString("fr-FR")} €`,
                    a.min_investment_score != null && `Score ≥ ${a.min_investment_score}`,
                    a.occupancy_status,
                  ].filter(Boolean).join(" · ") || "Aucun filtre"}
                </div>
              </div>
              <button onClick={() => toggle(a)} className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${a.is_active ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300" : "bg-muted text-muted-foreground"}`}>
                <Power className="h-3 w-3" /> {a.is_active ? "Active" : "Inactive"}
              </button>
              <button onClick={() => remove(a)} className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}