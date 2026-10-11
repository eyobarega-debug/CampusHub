import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { client, getTokens, setTokens, errMsg } from "../api/client";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    const tokens = getTokens();
    if (!tokens?.accessToken) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const { data } = await client.get("/users/me");
      setUser(data.user);
    } catch {
      setTokens(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMe();
    const onLogout = () => setUser(null);
    window.addEventListener("ch:logout", onLogout);
    return () => window.removeEventListener("ch:logout", onLogout);
  }, [loadMe]);

  async function login(email, password) {
    const { data } = await client.post("/auth/login", { email, password });
    setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
    setUser(data.user);
    return data.user;
  }

  async function register(payload) {
    const { data } = await client.post("/auth/register", payload);
    return data;
  }

  async function logout() {
    const tokens = getTokens();
    try {
      if (tokens?.refreshToken) await client.post("/auth/logout", { refreshToken: tokens.refreshToken });
    } catch {
      /* best-effort */
    }
    setTokens(null);
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
