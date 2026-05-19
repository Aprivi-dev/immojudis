import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState, useEffect, type FormEvent } from "react";
import type { SaleFilters as Filters } from "@/lib/types";

export function SaleFilters() {
  const navigate = useNavigate({ from: "/sales" });
  const search = useSearch({ from: "/sales" }) as Record<string, string | number | undefined>;
  const [local, setLocal] = useState<Filters>({});

  useEffect(() => {
    setLocal({
      department: (search.department as string) || "",
      city: (search.city as string) || "",
      property_type: (search.type as string) || "",
      max_price: search.max_price ? Number(search.max_price) : undefined,
      min_surface: search.min_surface ? Number(search.min_surface) : undefined,
      occupancy_status: (search.occupancy as string) || "",
      min_score: search.min_score ? Number(search.min_score) : undefined,
    });
  }, [search]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string | number> = {};
    if (local.department) next.department = local.department;
    if (local.city) next.city = local.city;
    if (local.property_type) next.type = local.property_type;
    if (local.max_price) next.max_price = local.max_price;
    if (local.min_surface) next.min_surface = local.min_surface;
    if (local.occupancy_status) next.occupancy = local.occupancy_status;
    if (local.min_score) next.min_score = local.min_score;
    navigate({ search: next });
  }

  function reset() {
    setLocal({});
    navigate({ search: {} });
  }

  const cls = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <form onSubmit={submit} className="rounded-lg border border-border bg-card p-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <input className={cls} placeholder="Département (ex: 33)" value={local.department ?? ""} onChange={(e) => setLocal({ ...local, department: e.target.value })} />
        <input className={cls} placeholder="Ville" value={local.city ?? ""} onChange={(e) => setLocal({ ...local, city: e.target.value })} />
        <select className={cls} value={local.property_type ?? ""} onChange={(e) => setLocal({ ...local, property_type: e.target.value })}>
          <option value="">Tous les types</option>
          <option value="apartment">Appartement</option>
          <option value="house">Maison</option>
          <option value="land">Terrain</option>
          <option value="commercial">Commercial</option>
          <option value="garage">Garage</option>
        </select>
        <input className={cls} type="number" placeholder="Prix max (€)" value={local.max_price ?? ""} onChange={(e) => setLocal({ ...local, max_price: e.target.value ? Number(e.target.value) : undefined })} />
        <input className={cls} type="number" placeholder="Surface min (m²)" value={local.min_surface ?? ""} onChange={(e) => setLocal({ ...local, min_surface: e.target.value ? Number(e.target.value) : undefined })} />
        <select className={cls} value={local.occupancy_status ?? ""} onChange={(e) => setLocal({ ...local, occupancy_status: e.target.value })}>
          <option value="">Occupation</option>
          <option value="free">Libre</option>
          <option value="occupied">Occupé</option>
          <option value="rented">Loué</option>
        </select>
        <input className={cls} type="number" placeholder="Score min" value={local.min_score ?? ""} onChange={(e) => setLocal({ ...local, min_score: e.target.value ? Number(e.target.value) : undefined })} />
      </div>
      <div className="mt-3 flex gap-2">
        <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">Filtrer</button>
        <button type="button" onClick={reset} className="rounded-md border border-border bg-background px-4 py-2 text-sm hover:bg-accent">Réinitialiser</button>
      </div>
    </form>
  );
}