"use client";

import { useQuery } from "@tanstack/react-query";
import { AdminPanel } from "@/components/admin/AdminShell";
import { queryProblem } from "@/components/admin/emails/email-ui";
import { fetchAdminEmailMessage } from "@/lib/client-api/admin-emails";

/**
 * Un message de l'historique. Un email envoyé s'affiche dans un cadre isolé (`sandbox=""`, aucun script,
 * aucune requête) ; un email reçu est du TEXTE seul, jamais du HTML, sans lien cliquable. Le serveur a déjà
 * masqué les liens d'action.
 */
export function EmailMessageView({ id, onClose }: { id: string; onClose: () => void }) {
  const query = useQuery({
    queryKey: ["admin-email-message", id],
    queryFn: () => fetchAdminEmailMessage(id),
    staleTime: 300_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const problem = queryProblem(query, "Chargement du message…");
  if (problem || !query.data) return problem;
  const message = query.data;
  return (
    <AdminPanel className="space-y-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-semibold">{message.title}</h2>
        <button type="button" className="admin-button-secondary" onClick={onClose}>
          Fermer
        </button>
      </div>
      {message.lines.map((line) => (
        <p key={line} className="text-xs text-brand-navy/70">
          {line}
        </p>
      ))}
      {message.kind === "html" ? (
        <iframe
          title="Contenu de l’email"
          sandbox=""
          srcDoc={message.body}
          referrerPolicy="no-referrer"
          className="h-[30rem] w-full rounded-lg border border-brand-navy/10 bg-white"
        />
      ) : (
        <pre className="whitespace-pre-wrap break-words text-sm">{message.body}</pre>
      )}
      {message.attachments.length > 0 ? (
        <ul className="list-disc pl-5 text-xs">
          {message.attachments.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      ) : null}
    </AdminPanel>
  );
}
