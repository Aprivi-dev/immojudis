import { Navigate, createFileRoute } from "@/lib/router-compat";
import { DEFAULT_PROPERTY } from "@/lib/mock-property";

export const Route = createFileRoute("/properties/")({
  component: PropertiesIndexRedirect,
});

function PropertiesIndexRedirect() {
  return <Navigate to="/properties/$id" params={{ id: DEFAULT_PROPERTY.slug }} replace />;
}
