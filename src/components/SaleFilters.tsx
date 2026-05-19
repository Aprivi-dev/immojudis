import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { Bell, RotateCcw, ArrowUpDown } from "lucide-react";
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
    });
  }, [search]);

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
      </div>
    </div>
  );
}