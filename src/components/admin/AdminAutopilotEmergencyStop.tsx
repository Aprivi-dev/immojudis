"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryErrorMessage } from "@/components/admin/admin-format";
import { AUTOPILOT_QUERY_KEY } from "@/components/admin/information-agent-queries";
import { runAdminInformationAgentAutopilotActionClient } from "@/lib/client-api";
import { toast } from "@/lib/toast";

/**
 * Arrêt d'urgence du pilote automatique : l'action `emergency_stop` existante (toujours permise, sans motif,
 * journalisée par la base), en un clic. Le même bouton dans le bandeau commun de l'Agent IA et dans le panneau
 * du pilote. Grisé seulement quand le pilote est connu pour être éteint : état non lu (chargement, panne), il
 * reste actif. La vue rendue remplace celle du pilote ; après une erreur, l'état est relu.
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
    onError: (error) => {
      toast.error(queryErrorMessage(error, "Arrêt impossible"));
      void queryClient.invalidateQueries({ queryKey: AUTOPILOT_QUERY_KEY });
    },
  });
  return (
    <button
      type="button"
      className="admin-button-primary"
      disabled={stop.isPending || mode === "off"}
      onClick={() => stop.mutate()}
    >
      Arrêt d’urgence
    </button>
  );
}
