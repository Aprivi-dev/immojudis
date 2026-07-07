import { useEffect, useState } from "react";
import { useNavigate } from "@/lib/router-compat";
import { useQueryClient } from "@tanstack/react-query";
import Heart from "lucide-react/dist/esm/icons/heart.js";
import {
  addFavoriteSale as addFavoriteSaleRequest,
  removeFavoriteSale as removeFavoriteSaleRequest,
} from "@/lib/client-api";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export function FavoriteButton({ saleId, className = "" }: { saleId: string; className?: string }) {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [isFav, setIsFav] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    supabase
      .from("user_favorites")
      .select("sale_id")
      .eq("user_id", user.id)
      .eq("sale_id", saleId)
      .maybeSingle()
      .then(({ data }) => setIsFav(!!data));
  }, [user, saleId]);

  async function toggle() {
    if (loading) return;
    if (!user) {
      const redirect =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : "/sales";
      navigate({ to: "/login", search: { redirect } });
      return;
    }
    setBusy(true);
    try {
      if (isFav) {
        await removeFavoriteSaleRequest({ saleId });
        setIsFav(false);
      } else {
        await addFavoriteSaleRequest({ data: { saleId } });
        setIsFav(true);
      }
      qc.invalidateQueries({ queryKey: ["favorites", user.id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={isFav}
      aria-label={isFav ? "Ne plus suivre cette vente" : "Suivre cette vente"}
      className={`liquid-panel-soft inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:border-gold hover:text-gold-soft disabled:opacity-50 ${className}`}
    >
      <Heart className={`h-3.5 w-3.5 ${isFav ? "fill-red-500 text-red-500" : ""}`} />
      {isFav ? "Vente suivie" : "Suivre cette vente"}
    </button>
  );
}
