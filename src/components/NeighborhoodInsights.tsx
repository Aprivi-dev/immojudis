import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Train, GraduationCap, HeartPulse, ShoppingBasket, Trees, Coffee } from "lucide-react";
import { getNeighborhoodAnalysis, type NeighborhoodAnalysis, type CategoryStats } from "@/lib/neighborhood.functions";

const CATEGORY_META: Record<
  keyof NeighborhoodAnalysis["categories"],
  { label: string; icon: React.ComponentType<{ className?: string }>; hint: string }
> = {
  transport: { label: "Mobilité", icon: Train, hint: "Gares, métro, tram, bus" },
  education: { label: "Éducation", icon: GraduationCap, hint: "Crèches, écoles, collèges, lycées" },
  health: { label: "Santé", icon: HeartPulse, hint: "Pharmacies, médecins, hôpitaux" },
  food: { label: "Courses", icon: ShoppingBasket, hint: "Supermarchés, boulangeries, marchés" },
  leisure: { label: "Loisirs", icon: Trees, hint: "Parcs, sport, culture" },
  daily: { label: "Vie quotidienne", icon: Coffee, hint: "Restaurants, cafés, commerces" },
};

function formatDistance(m: number | null): string {
  if (m == null) return "—";
  if (m < 1000) return `${m} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function walkScoreLabel(score: number): string {
  if (score >= 80) return "Quartier très vivant";
  if (score >= 60) return "Bien équipé";
  if (score >= 40) return "Correctement desservi";
  if (score >= 20) return "Quartier plus calme";
  return "Secteur isolé";
}

export function NeighborhoodInsights({ lat, lng }: { lat: number; lng: number }) {
  const fetchFn = useServerFn(getNeighborhoodAnalysis);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["neighborhood", lat.toFixed(5), lng.toFixed(5)],
    queryFn: () => fetchFn({ data: { lat, lng, radiusM: 800 } }),
    staleTime: 24 * 60 * 60_000,
    retry: 1,
  });

  if (isLoading) {
    return (
      <div className="border border-border bg-surface/40 p-6">
        <div className="h-4 w-40 animate-pulse bg-border/60" />
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse border border-border/60 bg-background/40" />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !data || !data.ok) {
    return (
      <div className="border border-border bg-surface/40 p-6 text-sm text-muted-foreground">
        {data?.error ?? "Analyse de quartier indisponible pour le moment."}
      </div>
    );
  }

  const categories = Object.entries(data.categories) as Array<
    [keyof NeighborhoodAnalysis["categories"], CategoryStats]
  >;
  const score = data.walkScore ?? 0;

  return (
    <div className="space-y-6">
      {/* Walk score banner */}
      <div className="relative border border-gold/30 bg-surface/60 p-6 backdrop-blur">
        <span className="absolute -top-px left-7 h-px w-12 bg-gold" />
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] text-gold-soft">
              Vie de quartier · rayon {data.radiusM} m
            </div>
            <div className="mt-3 font-display text-3xl text-foreground">{walkScoreLabel(score)}</div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Synthèse open data OpenStreetMap : équipements, commerces et transports accessibles à pied.
            </p>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-display text-5xl tabular-nums text-gold">{score}</span>
            <span className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">/ 100</span>
          </div>
        </div>
        <div className="mt-5 h-px w-full bg-border/40">
          <div
            className="h-px bg-gold transition-all"
            style={{ width: `${Math.max(2, score)}%` }}
          />
        </div>
      </div>

      {/* Category grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map(([key, stats]) => {
          const meta = CATEGORY_META[key];
          const Icon = meta.icon;
          const hasData = stats.count > 0;
          return (
            <div
              key={key}
              className="group relative border border-border bg-surface/40 p-5 transition-colors hover:border-gold/40"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <Icon className="h-4 w-4 text-gold" />
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                      {meta.label}
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground/70">{meta.hint}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-display text-2xl tabular-nums text-foreground">{stats.count}</div>
                </div>
              </div>

              {hasData ? (
                <div className="mt-4 border-t border-border/60 pt-3">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    Le plus proche
                  </div>
                  <div className="mt-1.5 flex items-baseline justify-between gap-3">
                    <span className="truncate text-sm font-medium text-foreground">
                      {stats.nearestName}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-gold-soft">
                      {formatDistance(stats.nearestM)}
                    </span>
                  </div>
                  {stats.samples.length > 1 && (
                    <ul className="mt-3 space-y-1">
                      {stats.samples.slice(1).map((p, i) => (
                        <li
                          key={i}
                          className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground"
                        >
                          <span className="truncate">{p.name}</span>
                          <span className="shrink-0 tabular-nums">{formatDistance(p.distanceM)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <div className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                  Aucun élément référencé dans ce rayon.
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        Source · OpenStreetMap (contributeurs ODbL)
      </p>
    </div>
  );
}
