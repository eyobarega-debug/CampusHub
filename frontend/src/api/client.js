import axios from "axios";

// Access token and CSRF token are kept strictly in memory — never in localStorage.
let inMemoryAccessToken = null;
let inMemoryCsrfToken = null;

// Clean up any legacy localStorage tokens from previous versions
try {
  localStorage.removeItem("ch_tokens");
} catch (_) {
  /* ignore */
}

export function getAccessToken() {
  return inMemoryAccessToken;
}

export function setAccessToken(token, csrf = null) {
  inMemoryAccessToken = token || null;
  if (csrf) inMemoryCsrfToken = csrf;
  if (!token) {
    inMemoryCsrfToken = null;
  }
}

export function getCsrfToken() {
  if (inMemoryCsrfToken) return inMemoryCsrfToken;
  if (typeof document !== "undefined") {
    const match = document.cookie.match(/(?:^|;\s*)ch_csrf=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

// Deprecated compatibility shims (never store refresh tokens)
export function getTokens() {
  return inMemoryAccessToken ? { accessToken: inMemoryAccessToken } : null;
}
export function setTokens(tokens) {
  setAccessToken(tokens?.accessToken || null);
}

const client = axios.create({
  baseURL: "/api",
  withCredentials: true,
});

client.interceptors.request.use((config) => {
  if (inMemoryAccessToken) {
    config.headers.Authorization = `Bearer ${inMemoryAccessToken}`;
  }
  const csrf = getCsrfToken();
  if (csrf) {
    config.headers["X-CSRF-Token"] = csrf;
  }
  return config;
});

let refreshingPromise = null;

export async function refreshSession() {
  if (refreshingPromise) return refreshingPromise;
  refreshingPromise = (async () => {
    try {
      const csrf = getCsrfToken();
      const headers = csrf ? { "X-CSRF-Token": csrf } : {};
      const { data } = await axios.post("/api/auth/refresh", {}, { withCredentials: true, headers });
      setAccessToken(data.accessToken, data.csrfToken);
      return data;
    } finally {
      refreshingPromise = null;
    }
  })();
  return refreshingPromise;
}

client.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    const status = error.response?.status;
    const errorCode = error.response?.data?.error?.code;

    // Invalidate session immediately if tenant is suspended, archived, or invalid
    const TENANT_SESSION_CODES = ["TENANT_SUSPENDED", "TENANT_ARCHIVED", "TENANT_INVALID"];
    if (status === 403 && TENANT_SESSION_CODES.includes(errorCode)) {
      setAccessToken(null);
      window.dispatchEvent(
        new CustomEvent("ch:logout", {
          detail: {
            code: errorCode,
            message: error.response?.data?.error?.message || "Your university access has been disabled.",
          },
        })
      );
      return Promise.reject(error);
    }

    if (status === 401 && !original._retry && !original.url.includes("/auth/")) {
      original._retry = true;
      try {
        const data = await refreshSession();
        original.headers.Authorization = `Bearer ${data.accessToken}`;
        return client(original);
      } catch (refreshErr) {
        setAccessToken(null);
        window.dispatchEvent(new Event("ch:logout"));
        return Promise.reject(refreshErr);
      }
    }
    return Promise.reject(error);
  }
);

export function errMsg(err, fallback = "Something went wrong") {
  return err?.response?.data?.error?.message || err?.message || fallback;
}

export { client };
