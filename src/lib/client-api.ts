import { supabase } from "@/integrations/supabase/client";
import type {
  AdminDashboardData,
  AdminScrollSource,
  StartScrollResult,
} from "@/lib/admin.functions";
import type { EnvironmentalContextResponse } from "@/lib/environment.functions";
import type { MarketContext } from "@/lib/market.functions";

async function authHeaders(): Promise<HeadersInit> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error("Connexion requise.");
  }

  return {
    Authorization: `Bearer ${session.access_token}`,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;

  if (!response.ok) {
    throw new Error(payload?.error ?? `Erreur HTTP ${response.status}`);
  }

  return payload as T;
}

export async function fetchMarketEstimate(args: { data: unknown }): Promise<MarketContext> {
  const response = await fetch("/api/market-estimate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<MarketContext>(response);
}

export async function fetchEnvironmentalContext(args: {
  data: unknown;
}): Promise<EnvironmentalContextResponse> {
  const response = await fetch("/api/environment-context", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args.data),
  });

  return readJson<EnvironmentalContextResponse>(response);
}

export async function fetchAdminDashboard(): Promise<AdminDashboardData> {
  const response = await fetch("/api/admin/dashboard", {
    headers: await authHeaders(),
  });

  return readJson<AdminDashboardData>(response);
}

export async function startAdminScrollRequest(args: {
  data: { source: AdminScrollSource };
}): Promise<StartScrollResult> {
  const response = await fetch("/api/admin/scroll", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
    },
    body: JSON.stringify(args.data),
  });

  return readJson<StartScrollResult>(response);
}
