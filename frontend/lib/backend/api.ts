import { BACKEND_API_URL } from "./config";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function buildUrl(path: string) {
  const base = BACKEND_API_URL.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

const BACKEND_FETCH_TIMEOUT_MS = 12_000;

export async function backendFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, BACKEND_FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(buildUrl(path), {
      ...init,
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(init?.headers || {}),
      },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    const isAbortError =
      error &&
      typeof error === "object" &&
      "name" in error &&
      String((error as { name?: string }).name || "") === "AbortError";

    if (isAbortError) {
      throw new Error(
        `Backend request timeout (> ${Math.floor(BACKEND_FETCH_TIMEOUT_MS / 1000)}s).`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const isJson = response.headers
    .get("content-type")
    ?.includes("application/json");
  const payload = isJson
    ? ((await response.json()) as T | { error?: string })
    : null;

  if (!response.ok) {
    const errorMessage =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: string }).error || "Request failed.")
        : `Request failed with status ${response.status}.`;
    throw new Error(errorMessage);
  }

  return payload as T;
}

export async function backendPost<T>(
  path: string,
  body?: JsonValue | Record<string, JsonValue>,
): Promise<T> {
  return backendFetch<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
