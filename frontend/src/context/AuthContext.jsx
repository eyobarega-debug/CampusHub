import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { client, getAccessToken, setAccessToken, refreshSession, errMsg } from "../api/client";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    try {
      // If we don't have an in-memory access token yet (e.g. initial load or reload),
      // restore the session using the HttpOnly refresh cookie.
      if (!getAccessToken()) {
        await refreshSession();
      }
      const { data } = await client.get("/users/me");
      setUser(data.user);
    } catch (err) {
      setAccessToken(null);
      setUser(null);
      const code = err?.response?.data?.error?.code;
      if (["TENANT_SUSPENDED", "TENANT_ARCHIVED", "TENANT_INVALID"].includes(code)) {
        navigate("/login", {
          state: { error: err?.response?.data?.error?.message || "Your university access has been disabled." },
          replace: true,
        });
      }
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    loadMe();
    const onLogout = (e) => {
      setAccessToken(null);
      setUser(null);
      if (e?.detail?.code && ["TENANT_SUSPENDED", "TENANT_ARCHIVED", "TENANT_INVALID"].includes(e.detail.code)) {
        navigate("/login", {
          state: { error: e.detail.message || "Your university access has been disabled." },
          replace: true,
        });
      }
    };
    window.addEventListener("ch:logout", onLogout);
    return () => window.removeEventListener("ch:logout", onLogout);
  }, [loadMe, navigate]);

  async function login(email, password) {
    const { data } = await client.post("/auth/login", { email, password });
    setAccessToken(data.accessToken, data.csrfToken);
    setUser(data.user);
    return data.user;
  }

  async function register(payload) {
    const { data } = await client.post("/auth/register", payload);
    return data;
  }

  async function logout() {
    try {
      await client.post("/auth/logout", {});
    } catch {
      /* best-effort */
    }
    setAccessToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, setUser, loading, login, register, logout, reload: loadMe }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export { errMsg };
