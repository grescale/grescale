export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface RequestOptions {
  method?: string;
  json?: unknown;
  form?: Record<string, string>;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    "X-Requested-With": "XMLHttpRequest",
  };

  let body: string | undefined;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.form !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(options.form).toString();
  }

  const res = await fetch(path, {
    method: options.method ?? (body !== undefined ? "POST" : "GET"),
    headers,
    body,
    credentials: "same-origin",
  });

  const contentType = res.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json") ? await res.json() : null;

  if (!res.ok) {
    const message =
      (data && typeof data.error === "string" && data.error) ||
      `Request failed with status ${res.status}`;

    if (res.status === 401 && !window.location.pathname.startsWith("/login")) {
      window.location.assign("/login");
    }

    throw new ApiError(res.status, message);
  }

  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, json?: unknown) => request<T>(path, { method: "POST", json }),
  postForm: <T>(path: string, form: Record<string, string>) =>
    request<T>(path, { method: "POST", form }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
