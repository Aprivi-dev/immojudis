import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.js";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type RawSearch = Record<string, string | number | undefined>;

const EMPTY = {
  department: "",
  city: "",
  type: "",
  max_price: "",
  occupancy: "",
  min_surface: "",
  min_score: "",
  sort: "date_asc",
  max_price_per_m2: "",
  min_yield: "",
  around_address: "",
  around_radius: "",
};

type LocalState = typeof EMPTY;

function fromSearch(search: RawSearch): LocalState {
  return {
    department: (search.department as string) ?? "",
    city: (search.city as string) ?? "",
    type: (search.type as string) ?? "",
    max_price: search.max_price != null ? String(search.max_price) : "",
    occupancy: (search.occupancy as string) ?? "",
    min_surface: search.min_surface != null ? String(search.min_surface) : "",
    min_score: search.min_score != null ? String(search.min_score) : "",
    sort: (search.sort as string) ?? "date_asc",
    max_price_per_m2: search.max_price_per_m2 != null ? String(search.max_price_per_m2) : "",
    min_yield: search.min_yield != null ? String(search.min_yield) : "",
    around_address: (search.around_address as string) ?? "",
    around_radius: search.around_radius != null ? String(search.around_radius) : "",
  };
}

export function MapFilterBar() {
  const navigate = useNavigate({ from: "/map" });
  const search = useSearch({ strict: false }) as RawSearch;
  const [local, setLocal] = useState<LocalState>(() => fromSearch(search));

  useEffect(() => {
    setLocal(fromSearch(search));
  }, [search]);

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
      if (local.occupancy) next.occupancy = local.occupancy;
      if (local.min_surface) next.min_surface = Number(local.min_surface);
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

  const set = (patch: Partial<LocalState>) => setLocal((c) => ({ ...c, ...patch }));
  const reset = () => setLocal({ ...EMPTY });

  const advancedCount = [
    local.occupancy,
    local.min_surface,
    local.min_score,
    local.max_price_per_m2,
    local.min_yield,
    local.around_address,
    local.around_radius,
  ].filter(Boolean).length;

  const hasAny =
    advancedCount > 0 || Boolean(local.department || local.city || local.type || local.max_price);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        aria-label="Département"
        placeholder="Dépt (33)"
        value={local.department}
        onChange={(e) => set({ department: e.target.value })}
        className="h-9 w-24 bg-background/40"
      />
      <Input
        aria-label="Ville"
        placeholder="Ville"
        value={local.city}
        onChange={(e) => set({ city: e.target.value })}
        className="h-9 w-32 bg-background/40"
      />
      <Select value={local.type || "all"} onValueChange={(v) => set({ type: v === "all" ? "" : v })}>
        <SelectTrigger aria-label="Type de bien" className="h-9 w-36">
          <SelectValue placeholder="Tous types" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Tous types</SelectItem>
          <SelectItem value="apartment">Appartement</SelectItem>
          <SelectItem value="house">Maison</SelectItem>
          <SelectItem value="land">Terrain</SelectItem>
          <SelectItem value="commercial">Commercial</SelectItem>
          <SelectItem value="garage">Garage</SelectItem>
        </SelectContent>
      </Select>
      <Input
        aria-label="Prix maximum"
        type="number"
        placeholder="Prix max €"
        value={local.max_price}
        onChange={(e) => set({ max_price: e.target.value })}
        className="h-9 w-28 bg-background/40"
      />
      <Select value={local.sort} onValueChange={(v) => set({ sort: v })}>
        <SelectTrigger aria-label="Tri" className="h-9 w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="date_asc">Date (plus proche)</SelectItem>
          <SelectItem value="score_desc">Pertinence</SelectItem>
          <SelectItem value="price_asc">Prix croissant</SelectItem>
          <SelectItem value="price_desc">Prix décroissant</SelectItem>
          <SelectItem value="surface_desc">Plus grande surface</SelectItem>
        </SelectContent>
      </Select>

      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="liquid-panel-soft h-9 gap-1.5 border-white/10"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Plus de filtres
            {advancedCount > 0 && (
              <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 text-[10px] font-bold text-background">
                {advancedCount}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Occupation">
              <Select
                value={local.occupancy || "all"}
                onValueChange={(v) => set({ occupancy: v === "all" ? "" : v })}
              >
                <SelectTrigger aria-label="Occupation" className="h-9">
                  <SelectValue placeholder="Toutes" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Toutes</SelectItem>
                  <SelectItem value="free">Libre</SelectItem>
                  <SelectItem value="occupied">Occupé</SelectItem>
                  <SelectItem value="rented">Loué</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Surface min (m²)">
              <Input
                type="number"
                placeholder="60"
                value={local.min_surface}
                onChange={(e) => set({ min_surface: e.target.value })}
                className="h-9 bg-background/40"
              />
            </Field>
            <Field label="Prix/m² max">
              <Input
                type="number"
                placeholder="3500"
                value={local.max_price_per_m2}
                onChange={(e) => set({ max_price_per_m2: e.target.value })}
                className="h-9 bg-background/40"
              />
            </Field>
            <Field label="Rendement min (%)">
              <Input
                type="number"
                placeholder="5"
                value={local.min_yield}
                onChange={(e) => set({ min_yield: e.target.value })}
                className="h-9 bg-background/40"
              />
            </Field>
            <Field label="Autour de">
              <Input
                placeholder="Adresse, ville"
                value={local.around_address}
                onChange={(e) => set({ around_address: e.target.value })}
                className="h-9 bg-background/40"
              />
            </Field>
            <Field label="Rayon (km)">
              <Input
                type="number"
                placeholder="10"
                value={local.around_radius}
                onChange={(e) => set({ around_radius: e.target.value })}
                className="h-9 bg-background/40"
              />
            </Field>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Recherche autour d'une adresse via api-adresse.data.gouv.fr.
          </p>
        </PopoverContent>
      </Popover>

      {hasAny && (
        <Button
          variant="ghost"
          size="sm"
          onClick={reset}
          className="h-9 gap-1.5 text-muted-foreground hover:text-gold"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Réinitialiser
        </Button>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1.5">
      <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
