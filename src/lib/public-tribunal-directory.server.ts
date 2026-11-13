import { unstable_cache } from "next/cache";
import {
  mapPublicTribunalDirectory,
  type PublicTribunalDirectoryEntry,
  type PublicTribunalDirectoryRow,
} from "@/lib/public-tribunal-directory";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";
import { tryPublicLoad, type PublicLoadResult } from "@/lib/public-load-result";
import { publicSupabaseConfigurationError } from "@/lib/supabase-configuration-error";

const PUBLIC_TRIBUNAL_DIRECTORY_REVALIDATE_SECONDS = 86_400;

type DirectoryRpcClient = {
  rpc: (fn: "get_public_tribunal_directory") => PromiseLike<{ data: unknown; error: unknown }>;
};

async function readPublicTribunalDirectory(): Promise<PublicTribunalDirectoryEntry[]> {
  const client = createPublicSupabaseClient();
  if (!client) throw publicSupabaseConfigurationError();
  const { data, error } = await (client as unknown as DirectoryRpcClient).rpc(
    "get_public_tribunal_directory",
  );
  if (error) throw error;
  return mapPublicTribunalDirectory((data ?? []) as PublicTribunalDirectoryRow[]);
}

// Le référentiel change rarement : une lecture par jour. Une erreur n'est jamais mise en cache.
const cachedPublicTribunalDirectory = unstable_cache(
  readPublicTribunalDirectory,
  ["public-tribunal-directory", "v1"],
  { revalidate: PUBLIC_TRIBUNAL_DIRECTORY_REVALIDATE_SECONDS, tags: ["public-tribunal-directory"] },
);

export type PublicTribunalDirectoryResult = PublicLoadResult<{
  items: PublicTribunalDirectoryEntry[];
}>;

/**
 * Les tribunaux connus. Ne lève pas : base indisponible, `error` ; l'appelant ne peut alors pas
 * affirmer qu'un tribunal est inconnu.
 */
export function tryLoadPublicTribunalDirectory(): Promise<PublicTribunalDirectoryResult> {
  return tryPublicLoad("[tribunaux] Référentiel des tribunaux indisponible:", async () => ({
    items: await cachedPublicTribunalDirectory(),
  }));
}
