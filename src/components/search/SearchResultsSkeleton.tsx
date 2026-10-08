import styles from "./SearchResults.module.css";

export function SearchResultsSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-xl border border-[#dce3eb] bg-white shadow-[0_1px_2px_rgba(19,34,56,0.05)]"
    >
      <div className={`${styles.skeletonMedia} animate-pulse`} />
      <div className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <div className={`${styles.skeletonLine} h-5 w-3/5`} />
            <div className={`${styles.skeletonLine} h-4 w-4/5`} />
          </div>
          <div className={`${styles.skeletonCircle} h-8 w-8 shrink-0`} />
        </div>
        <div className={`${styles.skeletonLine} h-7 w-2/5`} />
        <div className={`${styles.skeletonLine} h-3 w-1/3`} />
        <div className="flex gap-2 pt-1">
          <div className={`${styles.skeletonLine} h-3 w-1/4`} />
          <div className={`${styles.skeletonLine} h-3 w-1/4`} />
          <div className={`${styles.skeletonLine} h-3 w-1/5`} />
        </div>
      </div>
    </div>
  );
}
