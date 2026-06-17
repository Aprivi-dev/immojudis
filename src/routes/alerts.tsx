import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import Radar from "lucide-react/dist/esm/icons/radar.js";
import Power from "lucide-react/dist/esm/icons/power.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { getAlerts, createAlert, updateAlert, deleteAlert } from "@/lib/queries";
import type { UserAlert } from "@/lib/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/alerts")({
  component: AlertsPage,
});

function AlertsPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [toDelete, setToDelete] = useState<UserAlert | null>(null);
  const [form, setForm] = useState({
    name: "",
    department: "",
    city: "",
    property_type: "",
    max_price_eur: "",
    min_surface_m2: "",
    min_investment_score: "",
    occupancy_status: "",
  });

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/login" });
  }, [user, loading, navigate]);

  const { data: alerts = [] } = useQuery({
    queryKey: ["alerts", user?.id],
    queryFn: () => getAlerts(user!.id),
    enabled: !!user,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["alerts", user?.id] });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (!form.name.trim()) {
      toast.error("Nom requis");
      return;
    }
    try {
      await createAlert(user.id, {
        name: form.name.trim(),
        department: form.department || null,
        city: form.city || null,
        property_type: form.property_type || null,
        max_price_eur: form.max_price_eur ? Number(form.max_price_eur) : null,
        min_surface_m2: form.min_surface_m2 ? Number(form.min_surface_m2) : null,
        occupancy_status: form.occupancy_status || null,
        min_investment_score: form.min_investment_score ? Number(form.min_investment_score) : null,
      });
      toast.success("Alerte créée");
      setForm({
        name: "",
        department: "",
        city: "",
        property_type: "",
        max_price_eur: "",
        min_surface_m2: "",
        min_investment_score: "",
        occupancy_status: "",
      });
      invalidate();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  }

  async function toggle(a: UserAlert) {
    if (!user) return;
    await updateAlert(user.id, a.id, { is_active: !a.is_active });
    invalidate();
  }

  async function confirmDelete() {
    if (!user || !toDelete) return;
    await deleteAlert(user.id, toDelete.id);
    toast.success("Alerte supprimée");
    setToDelete(null);
    invalidate();
  }

  if (loading || !user)
    return (
      <main className="liquid-page min-h-screen px-4 py-10 text-muted-foreground sm:px-6">
        <div className="mx-auto max-w-6xl">Chargement…</div>
      </main>
    );

  return (
    <main className="liquid-page min-h-screen px-4 py-8 text-foreground sm:px-6 lg:py-10">
      <div className="mx-auto max-w-6xl">
        <header className="glass-shell mb-6 rounded-lg p-6 sm:p-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
                <Radar className="h-4 w-4" />
                Veille investisseur
              </div>
              <h1 className="mt-4 font-display text-4xl leading-tight text-foreground sm:text-5xl">
                Mes alertes
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Enregistrez vos critères pour retrouver rapidement les annonces qui correspondent à
                votre stratégie.
              </p>
            </div>
            <div className="liquid-panel-soft rounded-lg p-4">
              <div className="font-display text-3xl tabular-nums text-gold-soft">
                {alerts.length}
              </div>
              <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Alertes
              </div>
            </div>
          </div>
        </header>

        <form onSubmit={submit} className="glass-shell rounded-lg p-5 sm:p-6">
          <div className="flex items-center gap-3">
            <Bell className="h-5 w-5 text-gold" />
            <h2 className="font-display text-2xl text-foreground">Nouvelle alerte</h2>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Input
              placeholder="Nom de l'alerte *"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Input
              placeholder="Département (ex: 33)"
              value={form.department}
              onChange={(e) => setForm({ ...form, department: e.target.value })}
            />
            <Input
              placeholder="Ville"
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
            />
            <select
              className="form-input h-9 w-full text-sm"
              value={form.property_type || "all"}
              onChange={(e) =>
                setForm({
                  ...form,
                  property_type: e.target.value === "all" ? "" : e.target.value,
                })
              }
            >
              <option value="all">Tous les types</option>
              <option value="apartment">Appartement</option>
              <option value="house">Maison</option>
              <option value="land">Terrain</option>
              <option value="commercial">Commercial</option>
            </select>
            <Input
              type="number"
              placeholder="Prix max (€)"
              value={form.max_price_eur}
              onChange={(e) => setForm({ ...form, max_price_eur: e.target.value })}
            />
            <Input
              type="number"
              placeholder="Surface min (m²)"
              value={form.min_surface_m2}
              onChange={(e) => setForm({ ...form, min_surface_m2: e.target.value })}
            />
            <select
              className="form-input h-9 w-full text-sm"
              value={form.occupancy_status || "all"}
              onChange={(e) =>
                setForm({
                  ...form,
                  occupancy_status: e.target.value === "all" ? "" : e.target.value,
                })
              }
            >
              <option value="all">Toutes</option>
              <option value="free">Libre</option>
              <option value="occupied">Occupé</option>
              <option value="rented">Loué</option>
            </select>
          </div>
          <Button
            type="submit"
            className="liquid-button mt-4 border-0 text-background hover:brightness-105"
          >
            <Bell className="h-4 w-4" /> Créer l'alerte
          </Button>
        </form>

        <div className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-gold">
            Alertes existantes ({alerts.length})
          </h2>
          <div className="mt-3 space-y-2">
            {alerts.length === 0 && (
              <div className="liquid-panel-soft rounded-lg p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  Aucune alerte créée. Commencez par un département, un budget ou une surface cible.
                </p>
              </div>
            )}
            {alerts.map((a) => (
              <div
                key={a.id}
                className="liquid-panel-soft flex items-center justify-between gap-3 rounded-lg p-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-foreground">{a.name}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {[
                      a.department && `Dép. ${a.department}`,
                      a.city,
                      a.property_type,
                      a.max_price_eur != null && `≤ ${a.max_price_eur.toLocaleString("fr-FR")} €`,
                      a.min_surface_m2 != null && `Surface ≥ ${a.min_surface_m2} m²`,
                      a.min_investment_score != null && `Pertinence ≥ ${a.min_investment_score}`,
                      a.occupancy_status,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Aucun filtre"}
                  </div>
                </div>
                <button
                  onClick={() => toggle(a)}
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${a.is_active ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300" : "bg-muted text-muted-foreground"}`}
                >
                  <Power className="h-3 w-3" /> {a.is_active ? "Active" : "Inactive"}
                </button>
                <button
                  onClick={() => setToDelete(a)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label="Supprimer"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Supprimer cette alerte ?</AlertDialogTitle>
              <AlertDialogDescription>
                L'alerte « {toDelete?.name} » sera définitivement supprimée. Cette action est
                irréversible.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Annuler</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Supprimer
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </main>
  );
}
