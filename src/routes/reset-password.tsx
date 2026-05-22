import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/reset-password")({
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  // Supabase emits PASSWORD_RECOVERY when the user lands here from the email link
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setReady(true);
    });
    // Also check existing session (in case event fired before listener)
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      toast.error("Les mots de passe ne correspondent pas");
      return;
    }
    if (password.length < 8) {
      toast.error("8 caractères minimum");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      toast.success("Mot de passe mis à jour");
      navigate({ to: "/sales" });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md flex-col justify-center px-6 py-12">
      <div className="border border-border bg-card p-8">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">
          Nouveau mot de passe
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Choisissez un mot de passe robuste (8 caractères min, vérifié contre les fuites connues).
        </p>

        {!ready ? (
          <p className="mt-6 text-sm text-muted-foreground">
            Lien invalide ou expiré.{" "}
            <Link to="/login" className="text-[var(--gold)] underline">
              Demander un nouveau lien
            </Link>
          </p>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-3">
            <input
              type="password"
              required
              minLength={8}
              placeholder="Nouveau mot de passe"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-input bg-background px-3 py-2.5 text-sm"
            />
            <input
              type="password"
              required
              minLength={8}
              placeholder="Confirmer le mot de passe"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full border border-input bg-background px-3 py-2.5 text-sm"
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-[var(--gold)] px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--background)] hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Mise à jour…" : "Valider"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}