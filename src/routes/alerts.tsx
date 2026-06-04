import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import Power from "lucide-react/dist/esm/icons/power.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { getAlerts, createAlert, updateAlert, deleteAlert } from "@/lib/queries";
import type { UserAlert } from "@/lib/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
    return <main className="mx-auto max-w-5xl px-4 py-10 text-muted-foreground">Chargement…</main>;

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="text-2xl font-bold text-foreground">Mes alertes</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Créez des alertes pour enregistrer vos critères et retrouver rapidement les annonces
        correspondantes.
      </p>

      <form onSubmit={submit} className="mt-6 rounded-lg border border-border bg-card p-5">
        <h2 className="text-base font-semibold">Nouvelle alerte</h2>
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
          <Select
            value={form.property_type || "all"}
            onValueChange={(v) => setForm({ ...form, property_type: v === "all" ? "" : v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Type de bien" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tous les types</SelectItem>
              <SelectItem value="apartment">Appartement</SelectItem>
              <SelectItem value="house">Maison</SelectItem>
              <SelectItem value="land">Terrain</SelectItem>
              <SelectItem value="commercial">Commercial</SelectItem>
            </SelectContent>
          </Select>
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
          <Input
            type="number"
            placeholder="Score min"
            value={form.min_investment_score}
            onChange={(e) => setForm({ ...form, min_investment_score: e.target.value })}
          />
          <Select
            value={form.occupancy_status || "all"}
            onValueChange={(v) => setForm({ ...form, occupancy_status: v === "all" ? "" : v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Occupation" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Toutes</SelectItem>
              <SelectItem value="free">Libre</SelectItem>
              <SelectItem value="occupied">Occupé</SelectItem>
              <SelectItem value="rented">Loué</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" className="mt-4">
          <Bell className="h-4 w-4" /> Créer l'alerte
        </Button>
      </form>

      <div className="mt-8">
        <h2 className="text-base font-semibold text-foreground">
          Alertes existantes ({alerts.length})
        </h2>
        <div className="mt-3 space-y-2">
          {alerts.length === 0 && (
            <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              Aucune alerte créée.
            </p>
          )}
          {alerts.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-4"
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
                    a.min_investment_score != null && `Score ≥ ${a.min_investment_score}`,
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
    </main>
  );
}
