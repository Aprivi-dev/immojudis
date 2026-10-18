import { PageLoadingSkeleton } from "@/components/PageLoadingSkeleton";

export default function Loading() {
  // Le catalogue n'affiche pas les nuages : le squelette ne les télécharge pas non plus.
  return <PageLoadingSkeleton cloudBackground={false} />;
}
