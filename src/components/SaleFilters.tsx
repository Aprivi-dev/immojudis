import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import ArrowUpDown from "lucide-react/dist/esm/icons/arrow-up-down.js";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.js";
import { toast } from "sonner";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { createAlert } from "@/lib/queries";

type RawSearch = Record<string, string | number | undefined>;

export function SaleFilters({ from = "/sales" }: { from?: "/sales" | "/map" } = {}) {
  const navigate = useNavigate({ from });
  const search = useSearch({ strict: false }) as RawSearch;
  const { user } = useAuth();

  // Local state mirrors URL but is debounced before navigating
  const [local, setLocal] = useState({
    department: (search.department as string) ?? "",
    city: (search.city as string) ?? "",
    type: (search.type as string) ?? "",
    max_price: search.max_price != null ? String(search.max_price) : "",
    min_surface: search.min_surface != null ? String(search.min_surface) : "",
    occupancy: (search.occupancy as string) ?? "",
    min_score: search.min_score != null ? String(search.min_score) : "",
    sort: (search.sort as string) ?? "score_desc",
    max_price_per_m2: search.max_price_per_m2 != null ? String(search.max_price_per_m2) : "",
    min_yield: search.min_yield != null ? String(search.min_yield) : "",
    around_address: (search.around_address as string) ?? "",
    around_radius: search.around_radius != null ? String(search.around_radius) : "",
  });

  const [alertDialogOpen, setAlertDialogOpen] = useState(false);
  const [alertName, setAlertName] = useState("");
  const [savingAlert, setSavingAlert] = useState(false);

  // Sync down when URL changes externally (e.g. reset)
  useEffect(() => {
    setLocal({
      department: (search.department as string) ?? "",
      city: (search.city as string) ?? "",
      type: (search.type as string) ?? "",
      max_price: search.max_price != null ? String(search.max_price) : "",
      min_surface: search.min_surface != null ? String(search.min_surface) : "",
      occupancy: (search.occupancy as string) ?? "",
      min_score: search.min_score != null ? String(search.min_score) : "",
      sort: (search.sort as string) ?? "score_desc",
      max_price_per_m2: search.max_price_per_m2 != null ? String(search.max_price_per_m2) : "",
      min_yield: search.min_yield != null ? String(search.min_yield) : "",
      around_address: (search.around_address as string) ?? "",
      around_radius: search.around_radius != null ? String(search.around_radius) : "",
    });
  }, [search]);

  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(
      search.max_price_per_m2 || search.min_yield || search.around_address || search.around_radius,
    ),
  );

  // Debounced sync local -> URL
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const t = setTimeout(() => {
      const next: RawSearch = {};
      if (local.department) next.department = local.department;
      if (local.city) next.city = local.city;
      if (local.type) next.type = local.type;
      if (local.max_price) next.max_price = Number(local.max_price);
      if (local.min_surface) next.min_surface = Number(local.min_surface);
      if (local.occupancy) next.occupancy = local.occupancy;
      if (local.min_score) next.min_score = Number(local.min_score);
      if (local.sort && local.sort !== "score_desc") next.sort = local.sort;
      if (local.max_price_per_m2) next.max_price_per_m2 = Number(local.max_price_per_m2);
      if (local.min_yield) next.min_yield = Number(local.min_yield);
      if (local.around_address) next.around_address = local.around_address;
      if (local.around_radius) next.around_radius = Number(local.around_radius);
      navigate({ search: next, replace: true });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local]);

  function reset() {
    setLocal({
      department: "",
      city: "",
      type: "",
      max_price: "",
      min_surface: "",
      occupancy: "",
      min_score: "",
      sort: "score_desc",
      max_price_per_m2: "",
      min_yield: "",
      around_address: "",
      around_radius: "",
    });
  }

  const hasMainFilter = Boolean(
    local.department ||
    local.city ||
    local.type ||
    local.max_price ||
    local.min_surface ||
    local.occupancy ||
    local.min_score,
  );

  const hasAdvancedFilter = Boolean(
    local.max_price_per_m2 || local.min_yield || local.around_address || local.around_radius,
  );

  function openAlertDialog() {
    if (!user) {
      toast.error("Connectez-vous pour créer une alerte");
      return;
    }
    if (!hasMainFilter) {
      toast.error("Définissez au moins un filtre");
      return;
    }
    setAlertName(`Alerte ${local.department || local.city || local.type || ""}`.trim());
    setAlertDialogOpen(true);
  }

  async function saveAsAlert() {
    if (!user) return;
    const name = alertName.trim();
    if (!name) {
      toast.error("Nom requis");
      return;
    }
    setSavingAlert(true);
    try {
      await createAlert(user.id, {
        name,
        department: local.department || null,
        city: local.city || null,
        property_type: local.type || null,
        max_price_eur: local.max_price ? Number(local.max_price) : null,
        min_surface_m2: local.min_surface ? Number(local.min_surface) : null,
        occupancy_status: local.occupancy || null,
        min_investment_score: local.min_score ? Number(local.min_score) : null,
      });
      toast.success("Alerte créée");
      setAlertDialogOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setSavingAlert(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4" suppressHydrationWarning>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <FilterField label="Département">
          <Input
            aria-label="Département"
            placeholder="Ex: 33"
            value={local.department}
            onChange={(e) => setLocal({ ...local, department: e.target.value })}
          />
        </FilterField>
        <FilterField label="Ville">
          <Input
            aria-label="Ville"
            placeholder="Bordeaux"
            value={local.city}
            onChange={(e) => setLocal({ ...local, city: e.target.value })}
          />
        </FilterField>
        <FilterField label="Type">
          <Select
            value={local.type || "all"}
            onValueChange={(v) => setLocal({ ...local, type: v === "all" ? "" : v })}
          >
            <SelectTrigger aria-label="Type de bien">
              <SelectValue placeholder="Tous les types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tous les types</SelectItem>
              <SelectItem value="apartment">Appartement</SelectItem>
              <SelectItem value="house">Maison</SelectItem>
              <SelectItem value="land">Terrain</SelectItem>
              <SelectItem value="commercial">Commercial</SelectItem>
              <SelectItem value="garage">Garage</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>
        <FilterField label="Occupation">
          <Select
            value={local.occupancy || "all"}
            onValueChange={(v) => setLocal({ ...local, occupancy: v === "all" ? "" : v })}
          >
            <SelectTrigger aria-label="Occupation">
              <SelectValue placeholder="Occupation" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Toutes</SelectItem>
              <SelectItem value="free">Libre</SelectItem>
              <SelectItem value="occupied">Occupé</SelectItem>
              <SelectItem value="rented">Loué</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>
        <FilterField label="Prix max">
          <Input
            aria-label="Prix maximum"
            type="number"
            placeholder="250000"
            value={local.max_price}
            onChange={(e) => setLocal({ ...local, max_price: e.target.value })}
          />
        </FilterField>
        <FilterField label="Surface min">
          <Input
            aria-label="Surface minimum"
            type="number"
            placeholder="60"
            value={local.min_surface}
            onChange={(e) => setLocal({ ...local, min_surface: e.target.value })}
          />
        </FilterField>
        <FilterField label="Score min">
          <Input
            aria-label="Score minimum"
            type="number"
            placeholder="70"
            value={local.min_score}
            onChange={(e) => setLocal({ ...local, min_score: e.target.value })}
          />
        </FilterField>
        <FilterField label="Tri">
          <Select value={local.sort} onValueChange={(v) => setLocal({ ...local, sort: v })}>
            <SelectTrigger aria-label="Tri des annonces">
              <ArrowUpDown className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="score_desc">Meilleur score</SelectItem>
              <SelectItem value="date_asc">Date (plus proche)</SelectItem>
              <SelectItem value="date_desc">Date (plus lointaine)</SelectItem>
              <SelectItem value="price_asc">Prix croissant</SelectItem>
              <SelectItem value="price_desc">Prix décroissant</SelectItem>
              <SelectItem value="surface_desc">Plus grande surface</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>
      </div>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button
          variant="outline"
          size="sm"
          onClick={reset}
          className="justify-start sm:justify-center"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Réinitialiser
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={openAlertDialog}
          className="justify-start sm:justify-center"
        >
          <Bell className="h-3.5 w-3.5" /> Créer une alerte avec ces filtres
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((v) => !v)}
          className="justify-start sm:justify-center"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" /> Filtres avancés {advancedOpen ? "▴" : "▾"}
        </Button>
      </div>

      {advancedOpen && (
        <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border border-dashed border-border bg-muted/30 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <FilterField label="Prix au m² max">
            <Input
              aria-label="Prix au mètre carré maximum"
              type="number"
              placeholder="3500"
              value={local.max_price_per_m2}
              onChange={(e) => setLocal({ ...local, max_price_per_m2: e.target.value })}
            />
          </FilterField>
          <FilterField label="Rendement min">
            <Input
              aria-label="Rendement minimum"
              type="number"
              placeholder="5"
              value={local.min_yield}
              onChange={(e) => setLocal({ ...local, min_yield: e.target.value })}
            />
          </FilterField>
          <FilterField label="Autour de">
            <Input
              aria-label="Adresse de recherche"
              placeholder="Adresse, ville"
              value={local.around_address}
              onChange={(e) => setLocal({ ...local, around_address: e.target.value })}
            />
          </FilterField>
          <FilterField label="Rayon">
            <Input
              aria-label="Rayon en kilomètres"
              type="number"
              placeholder="10"
              value={local.around_radius}
              onChange={(e) => setLocal({ ...local, around_radius: e.target.value })}
            />
          </FilterField>
          <p className="col-span-full text-[11px] text-muted-foreground">
            Recherche autour d'une adresse via api-adresse.data.gouv.fr.
          </p>
        </div>
      )}

      <Dialog open={alertDialogOpen} onOpenChange={setAlertDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Créer une alerte</DialogTitle>
            <DialogDescription>
              L'alerte enregistrera les critères principaux actuellement appliqués.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Input
              autoFocus
              placeholder="Nom de l'alerte"
              value={alertName}
              onChange={(e) => setAlertName(e.target.value)}
            />
            <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              {[
                local.department && `Département ${local.department}`,
                local.city && `Ville : ${local.city}`,
                local.type && `Type : ${local.type}`,
                local.max_price &&
                  `Prix max : ${Number(local.max_price).toLocaleString("fr-FR")} €`,
                local.min_surface && `Surface min : ${local.min_surface} m²`,
                local.occupancy && `Occupation : ${local.occupancy}`,
                local.min_score && `Score min : ${local.min_score}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
            {hasAdvancedFilter && (
              <p className="text-xs text-muted-foreground">
                Les filtres avancés d'analyse locale ne sont pas enregistrés dans les alertes pour
                le moment.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAlertDialogOpen(false)}>
              Annuler
            </Button>
            <Button onClick={saveAsAlert} disabled={savingAlert}>
              {savingAlert ? "Création…" : "Créer l'alerte"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}
