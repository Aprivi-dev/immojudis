import type { Instrumentation } from "next";
import { reportError } from "@/lib/error-reporting";

/**
 * Server errors (route handlers, server components, server actions) go to the
 * configured error tracker.  Only the route pattern, the digest and the request
 * id are sent: no URL query, header, cookie or body.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const header = request.headers["x-request-id"];
  const requestId = Array.isArray(header) ? header[0] : header;
  await reportError(error, {
    source: context.routeType,
    route: context.routePath,
    requestId: requestId ?? null,
    digest:
      typeof error === "object" && error !== null && "digest" in error
        ? String((error as { digest: unknown }).digest)
        : null,
    extra: { method: request.method, renderSource: context.renderSource },
  });
};
