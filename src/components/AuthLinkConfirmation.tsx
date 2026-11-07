"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/integrations/supabase/lazy";
import { Button, Card, PageTitle } from "@/components/ui/primitives";
import {
  AUTH_CONFIRMATION_PATH,
  PASSWORD_RESET_EXPIRED_PATH,
  parseAuthLink,
  postConfirmationPath,
  type AuthLink,
  type AuthLinkType,
} from "@/lib/auth-confirmation";

/**
 * Page d'arrivée des liens des emails d'authentification (`/auth/confirmer`). Elle ne vérifie RIEN à
 * l'ouverture : certaines messageries et passerelles anti-hameçonnage ouvrent les liens d'un email
 * avant la personne, et un jeton à usage unique serait consommé avant qu'elle ne clique. La
 * vérification (`verifyOtp`) ne part qu'au clic sur le bouton.
 *
 * Page légère : elle n'importe pas `@supabase/supabase-js` ; le client n'est chargé qu'au clic, par
 * `getSupabase()`. Le jeton est effacé de l'adresse du navigateur dès le clic.
 */

const COPY: Record<AuthLinkType, { title: string; text: string; button: string }> = {
  signup: {
    title: "Confirmez votre adresse email",
    text: "Un clic pour activer votre compte Immojudis.",
    button: "Confirmer mon adresse",
  },
  recovery: {
    title: "Choisissez un nouveau mot de passe",
    text: "Un clic pour continuer vers le choix de votre nouveau mot de passe.",
    button: "Choisir un nouveau mot de passe",
  },
  email_change: {
    title: "Confirmez votre nouvelle adresse email",
    text: "Votre adresse ne changera qu’après confirmation.",
    button: "Confirmer le changement",
  },
  magiclink: {
    title: "Connexion à Immojudis",
    text: "Un clic pour vous connecter à votre compte.",
    button: "Me connecter",
  },
  invite: {
    title: "Invitation à rejoindre Immojudis",
    text: "Un clic pour accepter l’invitation et activer votre compte.",
    button: "Accepter l’invitation",
  },
};

type Phase = "reading" | "invalid" | "ready" | "verifying" | "failed";

export function AuthLinkConfirmation() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("reading");
  const [link, setLink] = useState<AuthLink | null>(null);

  useEffect(() => {
    const parsed = parseAuthLink(window.location.search);
    setLink(parsed);
    setPhase(parsed ? "ready" : "invalid");
  }, []);

  async function confirm() {
    if (!link || phase !== "ready") return;
    setPhase("verifying");
    // Le jeton ne reste ni dans la barre d'adresse ni dans l'historique, quelle que soit l'issue.
    window.history.replaceState(window.history.state, "", AUTH_CONFIRMATION_PATH);
    try {
      const supabase = await getSupabase();
      const { error } = await supabase.auth.verifyOtp({
        type: link.type,
        token_hash: link.tokenHash,
      });
      if (error) throw error;
      router.replace(postConfirmationPath(link, window.location.origin));
    } catch {
      if (link.type === "recovery") {
        // `PasswordRecovery` affiche « lien invalide ou expiré » et propose un nouveau lien.
        router.replace(PASSWORD_RESET_EXPIRED_PATH);
        return;
      }
      setPhase("failed");
    }
  }

  const copy = link ? COPY[link.type] : null;
  return (
    <main id="contenu" className="mx-auto min-h-[75vh] w-full max-w-md px-4 py-12 text-foreground">
      <Card as="section" className="sm:p-8">
        {phase === "reading" ? (
          <p role="status">Vérification du lien…</p>
        ) : phase === "invalid" || !link || !copy ? (
          <>
            <PageTitle>Lien incomplet</PageTitle>
            <p role="alert" className="mt-5 text-sm leading-relaxed">
              Ce lien est incomplet ou n’est plus valable. Ouvrez-le depuis l’email le plus récent
              reçu d’Immojudis, ou demandez-en un nouveau.
            </p>
            <Link href="/mot-de-passe-oublie" className="mt-5 block text-sm underline">
              Mot de passe oublié
            </Link>
          </>
        ) : phase === "failed" ? (
          <FailedLink link={link} />
        ) : (
          <>
            <PageTitle>{copy.title}</PageTitle>
            <p className="mt-5 text-sm leading-relaxed">{copy.text}</p>
            <p className="mt-3 text-xs text-muted-foreground">
              Pour votre sécurité, rien n’est validé tant que vous n’avez pas cliqué sur le bouton.
            </p>
            <Button
              variant="primary"
              onClick={() => void confirm()}
              disabled={phase === "verifying"}
              className="mt-6 w-full"
            >
              {phase === "verifying" ? "Veuillez patienter…" : copy.button}
            </Button>
          </>
        )}
        <Link href="/login" className="mt-6 block text-sm underline">
          Retour à la connexion
        </Link>
      </Card>
    </main>
  );
}

/** Lien expiré, déjà utilisé ou refusé : un message, et pour une inscription le renvoi de l'email. */
function FailedLink({ link }: { link: AuthLink }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resend(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const supabase = await getSupabase();
      const { error: resendError } = await supabase.auth.resend({
        type: "signup",
        email: email.trim(),
        options: {
          emailRedirectTo: `${window.location.origin}${postConfirmationPath(link, window.location.origin)}`,
        },
      });
      if (resendError) throw resendError;
      setNotice(`Email renvoyé à ${email.trim()}. Pensez à vérifier vos courriers indésirables.`);
    } catch {
      setError("Impossible de renvoyer l’email pour le moment. Réessayez.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle>Ce lien n’est plus valable</PageTitle>
      <p role="alert" className="mt-5 text-sm leading-relaxed">
        Il a expiré ou il a déjà servi. Les liens des emails Immojudis sont temporaires et ne
        fonctionnent qu’une fois.
      </p>
      {link.type === "signup" ? (
        <form onSubmit={resend} className="mt-6 grid gap-4">
          <label className="grid gap-2 text-sm">
            Adresse email du compte
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="form-input"
            />
          </label>
          <Button type="submit" variant="primary" disabled={busy || notice !== null}>
            {busy ? "Veuillez patienter…" : "Renvoyer l’email"}
          </Button>
          {notice ? (
            <p role="status" className="text-sm">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </form>
      ) : link.type === "magiclink" ? (
        <Link href="/login" className="mt-5 block text-sm underline">
          Vous connecter pour recevoir un nouveau lien
        </Link>
      ) : link.type === "invite" ? (
        <p className="mt-5 text-sm leading-relaxed">
          Pour recevoir une nouvelle invitation, contactez la personne qui vous l’a envoyée ou{" "}
          <Link href="/contact" className="underline">
            écrivez-nous
          </Link>
          .
        </p>
      ) : (
        <p className="mt-5 text-sm leading-relaxed">
          Pour confirmer votre nouvelle adresse, reprenez le changement depuis{" "}
          <Link href="/compte" className="underline">
            votre compte
          </Link>
          .
        </p>
      )}
    </>
  );
}
