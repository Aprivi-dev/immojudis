export default function Loading() {
  return (
    <main className="liquid-page min-h-screen px-4 py-10 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="h-8 w-48 animate-pulse rounded-md bg-white/70" />
        <div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-4">
            <div className="h-72 animate-pulse rounded-lg bg-white/70" />
            <div className="h-40 animate-pulse rounded-lg bg-white/70" />
          </div>
          <div className="hidden h-80 animate-pulse rounded-lg bg-white/70 lg:block" />
        </div>
      </div>
    </main>
  );
}
