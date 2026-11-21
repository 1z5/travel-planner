export const LOCAL_TRIPS_KEY = "tp.local-trip-files.v1";

export function localTripHref(id?: string): string {
  return id ? `/local?trip=${encodeURIComponent(id)}` : "/local?open=recent";
}

export function localTripId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("localId" in value)) return;
  const { localId } = value;
  if (
    typeof localId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(localId)
  )
    return localId;
}
