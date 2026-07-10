import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Check from "lucide-react/dist/esm/icons/check.js";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import KeyRound from "lucide-react/dist/esm/icons/key-round.js";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import { useState } from "react";
import { toast } from "sonner";
import { PremiumPreview } from "@/components/PremiumPreview";
import { useAuth } from "@/hooks/use-auth";
import {
  createApiKey,
  fetchApiKeys,
  fetchFeatureEntitlements,
  revokeApiKey,
} from "@/lib/client-api";

const API_KEYS_QUERY_KEY = ["api-keys"] as const;

export function ApiKeyManager() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState("Flux ventes");
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const entitlementsQuery = useQuery({
    queryKey: ["feature-entitlements", user?.id ?? "anonymous"],
    queryFn: fetchFeatureEntitlements,
    enabled: Boolean(user),
    staleTime: 5 * 60_000,
  });
  const apiAccessIncluded = entitlementsQuery.data?.plan.features.salesApiAccess === "included";
  const apiKeysQuery = useQuery({
    queryKey: [...API_KEYS_QUERY_KEY, user?.id ?? "anonymous"],
    queryFn: fetchApiKeys,
    enabled: Boolean(user) && apiAccessIncluded,
  });

  const createMutation = useMutation({
    mutationFn: () => createApiKey({ data: { name } }),
    onSuccess: async (response) => {
      setCreatedSecret(response.secret);
      setName("Flux ventes");
      toast.success("Clé API créée.");
      await queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Création impossible");
    },
  });

  const revokeMutation = useMutation({
    mutationFn: revokeApiKey,
    onSuccess: async () => {
      toast.success("Clé API révoquée.");
      await queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Révocation impossible");
    },
  });

  if (!user) return null;

  if (!apiAccessIncluded) {
    return <LockedApiKeyPreview />;
  }

  const keys = apiKeysQuery.data?.keys ?? [];
  const activeKeyCount = keys.filter((key) => !key.revokedAt).length;
  const limit = apiKeysQuery.data?.limit ?? 0;
  const limitReached = limit != null && activeKeyCount >= limit;

  return (
    <section className="mx-auto max-w-6xl px-4 pb-10 sm:px-6" aria-labelledby="api-key-title">
      <div className="rounded-lg border border-border bg-white/90 p-5 shadow-sm backdrop-blur">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-gold-soft">
              <KeyRound className="h-4 w-4" />
              Accès API léger
            </div>
            <h2 id="api-key-title" className="mt-2 font-display text-3xl text-foreground">
              Clés API ventes judiciaires
            </h2>
          </div>

          <form
            className="flex flex-col gap-2 sm:min-w-[22rem] sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (!limitReached) createMutation.mutate();
            }}
          >
            <label htmlFor="api-key-name" className="sr-only">
              Nom de la clé API
            </label>
            <input
              id="api-key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border bg-white px-3 py-2 text-sm font-medium outline-none transition focus:border-gold"
              maxLength={80}
              required
            />
            <button
              type="submit"
              disabled={createMutation.isPending || limitReached}
              className="ij-signup-button inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
            >
              {createMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              Créer
            </button>
          </form>
        </div>

        {createdSecret ? (
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <code className="min-w-0 overflow-x-auto rounded-md bg-white px-3 py-2 text-xs">
                {createdSecret}
              </code>
              <button
                type="button"
                onClick={() => void copyText(createdSecret)}
                className="inline-flex items-center justify-center gap-2 rounded-md border border-emerald-200 bg-white px-3 py-2 text-xs font-bold text-emerald-800"
              >
                <Copy className="h-3.5 w-3.5" />
                Copier
              </button>
            </div>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2 text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">
          <span className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1">
            <Check className="h-3.5 w-3.5 text-[#166534]" />
            {activeKeyCount}/{limit ?? "∞"} actives
          </span>
          <span className="inline-flex rounded-full bg-white px-3 py-1">GET /api/sales/feed</span>
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[1fr_0.8fr_0.7fr_auto] gap-3 bg-slate-50 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            <span>Nom</span>
            <span>Préfixe</span>
            <span>Statut</span>
            <span />
          </div>
          <div className="divide-y divide-border">
            {apiKeysQuery.isLoading ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Chargement
              </div>
            ) : keys.length ? (
              keys.map((key) => (
                <div
                  key={key.id}
                  className="grid grid-cols-[1fr_0.8fr_0.7fr_auto] items-center gap-3 px-3 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-foreground">{key.name}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {key.lastUsedAt ? `Dernier usage ${formatDateTime(key.lastUsedAt)}` : "—"}
                    </div>
                  </div>
                  <code className="truncate text-xs text-muted-foreground">{key.keyPrefix}…</code>
                  <span className="text-xs text-muted-foreground">
                    {key.revokedAt ? "Révoquée" : "Active"}
                  </span>
                  <button
                    type="button"
                    disabled={Boolean(key.revokedAt) || revokeMutation.isPending}
                    onClick={() => revokeMutation.mutate({ keyId: key.id })}
                    className="inline-grid h-8 w-8 place-items-center rounded-md border border-border text-muted-foreground transition hover:border-red-300/50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-45"
                    aria-label="Révoquer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            ) : (
              <div className="px-3 py-4 text-sm text-muted-foreground">Aucune clé API</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function LockedApiKeyPreview() {
  return (
    <div className="mx-auto max-w-6xl px-4 pb-10 sm:px-6">
      <PremiumPreview
        title="Clés API ventes judiciaires"
        description="Créez des clés révocables et interrogez le flux de ventes avec l'offre Analyse."
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-gold-soft">
              <KeyRound className="h-4 w-4" aria-hidden />
              Accès API léger
            </div>
            <h2 className="mt-2 font-display text-3xl text-foreground">
              Clés API ventes judiciaires
            </h2>
          </div>
          <div className="flex gap-2">
            <div className="h-10 w-52 rounded-md border bg-white" />
            <div className="h-10 w-24 rounded-md bg-primary/70" />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-[1fr_0.8fr_0.7fr] gap-3 rounded-lg border p-4 text-sm">
          <span>Flux ventes</span>
          <code>ij_live_8f2…</code>
          <span>Active</span>
        </div>
      </PremiumPreview>
    </div>
  );
}

async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
  toast.success("Clé copiée.");
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
