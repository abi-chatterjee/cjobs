let csrfToken = null;

export function setCsrfToken(t) {
  csrfToken = t;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function api(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const headers = Object.assign({}, opts.headers);
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (!SAFE_METHODS.has(method) && csrfToken) headers["X-CSRF-Token"] = csrfToken;

  const res = await fetch(path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });

  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("not authenticated");
  }

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    /* empty body */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `request failed (${res.status})`);
    err.status = res.status;
    err.fields = data && data.fields;
    throw err;
  }
  return data;
}
