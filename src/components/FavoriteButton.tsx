import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Heart } from "lucide-react";
import { addFavorite, removeFavorite } from "@/lib/queries";
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
      navigate({ to: "/login" });
      return;
    }
    setBusy(true);
    try {
      if (isFav) {
        await removeFavorite(user.id, saleId);
        setIsFav(false);
      } else {
        await addFavorite(user.id, saleId);
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
      className={`inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium transition hover:bg-accent disabled:opacity-50 ${className}`}
    >
      <Heart className={`h-3.5 w-3.5 ${isFav ? "fill-red-500 text-red-500" : ""}`} />
      {isFav ? "Retiré" : "Favori"}
    </button>
  );
}