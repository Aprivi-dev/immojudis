import { Skeleton } from "@/components/ui/skeleton";

export function PropertyPageSkeleton() {
  return (
    <main className="min-h-screen bg-[#f7f5f1] text-foreground">
      <div className="border-b border-border bg-white px-4 py-4 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-11 w-full max-w-md" />
        </div>
      </div>
      <Skeleton className="h-[31rem] w-full rounded-none" />
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:px-8">
        <div className="space-y-6">
          <Skeleton className="h-12 w-64" />
          <Skeleton className="h-28 w-full" />
          <div className="grid gap-3 md:grid-cols-3">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
          <Skeleton className="h-[22rem] w-full" />
        </div>
        <Skeleton className="hidden h-[32rem] lg:block" />
      </div>
    </main>
  );
}
