import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { client, getAccessToken, setAccessToken, refreshSession, errMsg } from "../api/client";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
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
    } catch {
      setAccessToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMe();
    const onLogout = () => {
      setAccessToken(null);
      setUser(null);
    };
    window.addEventListener("ch:logout", onLogout);
    return () => window.removeEventListener("ch:logout", onLogout);
  }, [loadMe]);

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
