"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryErrorMessage } from "@/components/admin/admin-format";
import { AUTOPILOT_QUERY_KEY } from "@/components/admin/information-agent-queries";
import { runAdminInformationAgentAutopilotActionClient } from "@/lib/client-api";
import { toast } from "@/lib/toast";

/**
 * Arrêt d'urgence du pilote automatique : l'action `emergency_stop` existante (toujours permise, sans motif,
 * journalisée par la base). Le même bouton dans le bandeau commun de l'Agent IA et dans le panneau du pilote ;
 * actif seulement quand le pilote tourne. La vue rendue remplace celle du pilote : bandeau et panneau suivent.
 */
export function AdminAutopilotEmergencyStop({
  mode,
}: {
  mode: "off" | "simulation" | "live" | null;
}) {
  const queryClient = useQueryClient();
  const stop = useMutation({
    mutationFn: () => runAdminInformationAgentAutopilotActionClient({ action: "emergency_stop" }),
    onSuccess: (view) => {
      queryClient.setQueryData(AUTOPILOT_QUERY_KEY, view);
      toast.success("Pilote automatique arrêté.");
    },
    onError: (error) => toast.error(queryErrorMessage(error, "Arrêt impossible")),
  });
  return (
    <button
      type="button"
      className="admin-button-primary"
      disabled={stop.isPending || !mode || mode === "off"}
      onClick={() => stop.mutate()}
    >
      Arrêt d’urgence
    </button>
  );
}
