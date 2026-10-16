const DEFAULT_CONCURRENCY = 4;

export type PagedReadOptions<T> = {
  /** Number of rows asked for by each page. A page shorter than this is the last one. */
  pageSize: number;
  /** Upper bound on the rows read. Reaching it with only full pages means the read was cut. */
  maxRows: number;
  /** Reads the page starting at `offset` (0, pageSize, 2 × pageSize…). */
  readPage: (offset: number) => Promise<T[]>;
  /**
   * Total number of rows, asked at the same time as the first page. It only plans how many pages
   * are read in parallel: it is never trusted for the result. An error or `null` falls back to
   * reading the pages one after the other.
   */
  countTotal?: () => Promise<number | null>;
  /** Pages in flight at the same time (4 by default). */
  concurrency?: number;
};

export type PagedReadResult<T> = {
  rows: T[];
  /** Every page up to `maxRows` was full: there may be more rows than were read. */
  truncated: boolean;
};

async function readTotal(countTotal: () => Promise<number | null>): Promise<number | null> {
  try {
    const total = await countTotal();
    return typeof total === "number" && Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

/**
 * Reads a paginated list in the same order and with the same result as reading the pages one
 * after the other until a short page (or `maxRows`), but with the pages after the first read in
 * parallel once the total is known.
 *
 * - A short result costs one round trip, like before (the first page and the total start together).
 * - The total only plans the parallel reads. If it is too low, the missing pages are read one by
 *   one; if it is too high, the pages after the first short one are dropped.
 * - The rows are assembled in page order and stop at the first short page.
 * - The first failing page rejects the whole read, and no further page is started.
 */
export async function readPagedRows<T>({
  pageSize,
  maxRows,
  readPage,
  countTotal,
  concurrency = DEFAULT_CONCURRENCY,
}: PagedReadOptions<T>): Promise<PagedReadResult<T>> {
  const maxPages = Math.ceil(maxRows / pageSize);
  const pages: (T[] | undefined)[] = [];

  const [first, total] = await Promise.all([
    readPage(0),
    countTotal ? readTotal(countTotal) : null,
  ]);
  pages[0] = first;
  if (first.length < pageSize || maxPages <= 1) {
    return { rows: first, truncated: first.length >= pageSize };
  }

  // Pages 1..planned-1 in parallel, in the order of their numbers, `concurrency` at a time.
  const planned = total != null && total > 0 ? Math.min(maxPages, Math.ceil(total / pageSize)) : 1;
  let next = 1;
  let ended = Number.POSITIVE_INFINITY; // index of the first short page seen so far
  let failed = false;
  const worker = async () => {
    while (!failed && next < planned && next < ended) {
      const index = next++;
      let page: T[];
      try {
        page = await readPage(index * pageSize);
      } catch (error) {
        failed = true;
        throw error;
      }
      pages[index] = page;
      if (page.length < pageSize) ended = Math.min(ended, index);
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(concurrency) || 1, planned - 1));
  await Promise.all(Array.from({ length: workers }, worker));

  // Every planned page was full (a failed read has already thrown). The total was too low, or
  // unknown: carry on one page at a time, as before.
  if (ended === Number.POSITIVE_INFINITY) {
    for (let index = planned; index < maxPages; index += 1) {
      const page = await readPage(index * pageSize);
      pages[index] = page;
      if (page.length < pageSize) {
        ended = index;
        break;
      }
    }
  }

  // Pages are started in order, so every page up to the first short one has been read; the ones
  // read after it (the total was too high) are dropped.
  const truncated = ended === Number.POSITIVE_INFINITY;
  const last = truncated ? maxPages - 1 : ended;
  const rows: T[] = [];
  for (let index = 0; index <= last; index += 1) rows.push(...(pages[index] ?? []));
  return { rows, truncated };
}
