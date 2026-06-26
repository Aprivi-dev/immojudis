import { createFileRoute } from "@tanstack/react-router";
import {
  RESOURCES_CANONICAL,
  RESOURCES_TITLE,
  ResourcesPage,
} from "./ventes-immobilieres-judiciaires";

const DESCRIPTION =
  "Ressources Immojudis pour comprendre les ventes immobilières judiciaires : annonces, risques, frais, occupation et prix plafond.";

export const Route = createFileRoute("/ressources")({
  head: () => ({
    meta: [
      { title: RESOURCES_TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "robots", content: "index, follow" },
      { property: "og:type", content: "website" },
      { property: "og:title", content: RESOURCES_TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:url", content: RESOURCES_CANONICAL },
    ],
    links: [{ rel: "canonical", href: RESOURCES_CANONICAL }],
  }),
  component: ResourcesPage,
});
