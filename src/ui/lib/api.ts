export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error ?? response.statusText);
  }
  return response.json() as Promise<T>;
}

export function parseWatchEvent(event: Event): { comparisonKey?: string } | null {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") return null;
  try {
    const payload = JSON.parse(event.data) as { comparisonKey?: unknown };
    return typeof payload.comparisonKey === "string" ? { comparisonKey: payload.comparisonKey } : null;
  } catch {
    return null;
  }
}
