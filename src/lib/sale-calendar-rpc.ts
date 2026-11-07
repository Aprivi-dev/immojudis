export type RpcError = { code?: string; message?: string } | null;
export function isMissingCalendarFunction(error: RpcError): boolean {
  return (
    error?.code === "PGRST202" ||
    error?.code === "42883" ||
    /get_public_sale_calendar_event/.test(error?.message ?? "")
  );
}
