import { useState } from "react";
import { useRouter } from "next/navigation";
import { loginPathWithRedirect } from "@/lib/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Heart from "lucide-react/dist/esm/icons/heart.js";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import * as queryKeys from "@/lib/query-keys";
import { toggleFavoriteSale, useFavoriteRemovalConfirmation } from "./favorite-removal";
import {
  FAVORITE_ADD_LABEL,
  FAVORITE_ANONYMOUS_TITLE,
  FAVORITE_REMOVE_LABEL,
} from "./favorite-feedback";

export function FavoriteButton({
  saleId,
  className = "",
  compact = false,
}: {
  saleId: string;
  className?: string;
  compact?: boolean;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { confirmRemoval, dialog: removalDialog } = useFavoriteRemovalConfirmation();

  const favoriteKey = queryKeys.favoriteStatus(user?.id ?? null, saleId);
  const favorite = useQuery({
    queryKey: favoriteKey,
    enabled: Boolean(user) && !loading,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_favorites")
        .select("sale_id")
        .eq("user_id", user!.id)
        .eq("sale_id", saleId)
        .maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },
  });
  const isFav = Boolean(user) && !loading && favorite.data === true;

  async function toggle() {
    if (loading || busy) return;
    if (!user) {
      const redirect =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : "/sales";
      router.push(loginPathWithRedirect(redirect, { reason: "favori" }));
      return;
    }
    if (favorite.isPending || favorite.isError) {
      void favorite.refetch();
      return;
    }
    setBusy(true);
    try {
      await toggleFavoriteSale({
        queryClient: qc,
        userId: user.id,
        saleId,
        favorite: isFav,
        confirmRemoval,
        onToggled: (next) => qc.setQueryData(favoriteKey, next),
      });
    } finally {
      setBusy(false);
    }
  }

  const label = isFav ? FAVORITE_REMOVE_LABEL : FAVORITE_ADD_LABEL;
  const title = !user && !loading ? FAVORITE_ANONYMOUS_TITLE : label;

  return (
    <>
      {removalDialog}
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void toggle();
        }}
        disabled={busy || loading || (Boolean(user) && favorite.isPending)}
        aria-pressed={isFav}
        aria-label={label}
        title={title}
        className={`${compact ? "inline-flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 bg-white text-brand-navy" : "liquid-panel-soft inline-flex min-h-11 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-foreground"} transition hover:border-gold hover:text-gold-text disabled:opacity-50 ${className}`}
      >
        <Heart
          aria-hidden
          className={`${compact ? "h-5 w-5" : "h-3.5 w-3.5"} ${isFav ? "fill-red-500 text-red-500" : ""}`}
        />
        {!compact ? label : null}
      </button>
    </>
  );
}
