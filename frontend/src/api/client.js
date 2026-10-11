import axios from "axios";

const client = axios.create({ baseURL: "/api" });

function getTokens() {
  try {
    return JSON.parse(localStorage.getItem("ch_tokens") || "null");
  } catch {
    return null;
  }
}
function setTokens(tokens) {
  if (tokens) localStorage.setItem("ch_tokens", JSON.stringify(tokens));
  else localStorage.removeItem("ch_tokens");
}

client.interceptors.request.use((config) => {
  const tokens = getTokens();
  if (tokens?.accessToken) config.headers.Authorization = `Bearer ${tokens.accessToken}`;
  return config;
});

let refreshing = null;

client.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    const status = error.response?.status;

    if (status === 401 && !original._retry && !original.url.includes("/auth/")) {
      original._retry = true;
      const tokens = getTokens();
      if (!tokens?.refreshToken) {
        setTokens(null);
        window.dispatchEvent(new Event("ch:logout"));
        return Promise.reject(error);
      }
      try {
        // De-duplicate concurrent refresh calls.
        refreshing =
          refreshing ||
          axios.post("/api/auth/refresh", { refreshToken: tokens.refreshToken }).finally(() => {
            refreshing = null;
          });
        const { data } = await refreshing;
        setTokens({ accessToken: data.accessToken, refreshToken: tokens.refreshToken });
        original.headers.Authorization = `Bearer ${data.accessToken}`;
        return client(original);
      } catch (refreshErr) {
        setTokens(null);
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

export { client, getTokens, setTokens };
