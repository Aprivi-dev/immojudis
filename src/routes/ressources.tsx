import { createFileRoute, redirect } from "@/lib/router-compat";

const TARGET = "/ventes-immobilieres-judiciaires";

export const Route = createFileRoute("/ressources")({
  beforeLoad: () => {
    throw redirect({ to: TARGET, replace: true });
  },
  component: ResourcesRedirect,
});

function ResourcesRedirect() {
  return null;
}
