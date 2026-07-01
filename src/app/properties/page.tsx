import { redirect } from "next/navigation";
import { DEFAULT_PROPERTY } from "@/lib/mock-property";

export default function Page() {
  redirect(`/properties/${DEFAULT_PROPERTY.slug}`);
}
