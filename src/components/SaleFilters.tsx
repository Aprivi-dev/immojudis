import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { Bell, RotateCcw, ArrowUpDown, SlidersHorizontal } from "lucide-react";
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
import { useAuth } from "@/hooks/use-auth";
import { createAlert } from "@/lib/queries";

type RawSearch = Record<string, string | number | undefined>;

export function SaleFilters() {
  const navigate = useNavigate({ from: "/sales" });
  const search = useSearch({ from: "/sales" }) as RawSearch;
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
    sort: (search.sort as string) ?? "date_asc",
    max_price_per_m2: search.max_price_per_m2 != null ? String(search.max_price_per_m2) : "",
    min_yield: search.min_yield != null ? String(search.min_yield) : "",
    around_address: (search.around_address as string) ?? "",
    around_radius: search.around_radius != null ? String(search.around_radius) : "",
  });

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
      sort: (search.sort as string) ?? "date_asc",
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
      if (local.sort && local.sort !== "date_asc") next.sort = local.sort;
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
      sort: "date_asc",
      max_price_per_m2: "",
      min_yield: "",
      around_address: "",
      around_radius: "",
    });
  }

  async function saveAsAlert() {
    if (!user) {
      toast.error("Connectez-vous pour créer une alerte");
      return;
    }
    const hasFilter =
      local.department || local.city || local.type || local.max_price ||
      local.min_surface || local.occupancy || local.min_score;
    if (!hasFilter) {
      toast.error("Définissez au moins un filtre");
      return;
    }
    const name = window.prompt("Nom de l'alerte ?", `Alerte ${local.department || local.city || local.type || ""}`.trim());
    if (!name) return;
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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        <Input placeholder="Département (ex: 33)" value={local.department} onChange={(e) => setLocal({ ...local, department: e.target.value })} />
        <Input placeholder="Ville" value={local.city} onChange={(e) => setLocal({ ...local, city: e.target.value })} />
        <Select value={local.type || "all"} onValueChange={(v) => setLocal({ ...local, type: v === "all" ? "" : v })}>
          <SelectTrigger><SelectValue placeholder="Tous les types" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous les types</SelectItem>
            <SelectItem value="apartment">Appartement</SelectItem>
            <SelectItem value="house">Maison</SelectItem>
            <SelectItem value="land">Terrain</SelectItem>
            <SelectItem value="commercial">Commercial</SelectItem>
            <SelectItem value="garage">Garage</SelectItem>
          </SelectContent>
        </Select>
        <Select value={local.occupancy || "all"} onValueChange={(v) => setLocal({ ...local, occupancy: v === "all" ? "" : v })}>
          <SelectTrigger><SelectValue placeholder="Occupation" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Occupation</SelectItem>
            <SelectItem value="free">Libre</SelectItem>
            <SelectItem value="occupied">Occupé</SelectItem>
            <SelectItem value="rented">Loué</SelectItem>
          </SelectContent>
        </Select>
        <Input type="number" placeholder="Prix max (€)" value={local.max_price} onChange={(e) => setLocal({ ...local, max_price: e.target.value })} />
        <Input type="number" placeholder="Surface min (m²)" value={local.min_surface} onChange={(e) => setLocal({ ...local, min_surface: e.target.value })} />
        <Input type="number" placeholder="Score min" value={local.min_score} onChange={(e) => setLocal({ ...local, min_score: e.target.value })} />
        <Select value={local.sort} onValueChange={(v) => setLocal({ ...local, sort: v })}>
          <SelectTrigger>
            <ArrowUpDown className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="date_asc">Date (plus proche)</SelectItem>
            <SelectItem value="date_desc">Date (plus lointaine)</SelectItem>
            <SelectItem value="price_asc">Prix croissant</SelectItem>
            <SelectItem value="price_desc">Prix décroissant</SelectItem>
            <SelectItem value="score_desc">Meilleur score</SelectItem>
            <SelectItem value="surface_desc">Plus grande surface</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={reset}>
          <RotateCcw className="h-3.5 w-3.5" /> Réinitialiser
        </Button>
        <Button variant="secondary" size="sm" onClick={saveAsAlert}>
          <Bell className="h-3.5 w-3.5" /> Créer une alerte avec ces filtres
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setAdvancedOpen((v) => !v)}>
          <SlidersHorizontal className="h-3.5 w-3.5" /> Filtres avancés {advancedOpen ? "▴" : "▾"}
        </Button>
      </div>

      {advancedOpen && (
        <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border border-dashed border-border bg-muted/30 p-3 md:grid-cols-2 lg:grid-cols-4">
          <Input
            type="number"
            placeholder="Prix max €/m²"
            value={local.max_price_per_m2}
            onChange={(e) => setLocal({ ...local, max_price_per_m2: e.target.value })}
          />
          <Input
            type="number"
            placeholder="Rendement min %"
            value={local.min_yield}
            onChange={(e) => setLocal({ ...local, min_yield: e.target.value })}
          />
          <Input
            placeholder="Autour de l'adresse"
            value={local.around_address}
            onChange={(e) => setLocal({ ...local, around_address: e.target.value })}
          />
          <Input
            type="number"
            placeholder="Rayon (km)"
            value={local.around_radius}
            onChange={(e) => setLocal({ ...local, around_radius: e.target.value })}
          />
          <p className="col-span-full text-[11px] text-muted-foreground">
            Rendement = estimation brute selon loyer médian du département (frais d'enchère 10 % inclus). Distance via api-adresse.data.gouv.fr.
          </p>
        </div>
      )}
    </div>
  );
}