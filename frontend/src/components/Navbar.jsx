import { Link, NavLink, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { client } from "../api/client";
import { Button, Badge } from "./ui";
import { visibleTabs } from "../config/roles";

const linkClass = ({ isActive }) =>
  `rounded-lg px-3 py-1.5 text-sm font-medium transition ${
    isActive ? "bg-white/15 text-white" : "text-white/80 hover:bg-white/10 hover:text-white"
  }`;

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    async function poll() {
      try {
        const { data } = await client.get("/notifications", { params: { unreadOnly: true } });
        if (!cancelled) setUnread(data.unreadCount);
      } catch {
        /* ignore */
      }
    }
    poll();
    const id = setInterval(poll, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [user]);

  return (
    <nav className="sticky top-0 z-40 bg-navy shadow-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <Link to="/" className="flex items-center gap-2 text-lg font-bold text-white">
          <span className="rounded-md bg-accent px-2 py-0.5 text-white">CH</span>
          CampusHub
        </Link>

        <div className="flex flex-1 flex-wrap items-center gap-1">
          {visibleTabs(user).map((t) => (
            <NavLink key={t.key} to={t.to} className={linkClass}>
              {t.label}
            </NavLink>
          ))}
        </div>

        <div className="flex items-center gap-3">
          {user ? (
            <>
              <NavLink to="/notifications" className="relative text-white/80 hover:text-white" title="Notifications">
                🔔
                {unread > 0 && (
                  <span className="absolute -right-2 -top-2">
                    <Badge tone="accent">{unread}</Badge>
                  </span>
                )}
              </NavLink>
              <NavLink to="/profile" className="text-sm text-white/90 hover:text-white">
                {user.name?.split(" ")[0]}
              </NavLink>
              <Button
                variant="outline"
                className="border-white/30 text-white hover:bg-white/10"
                onClick={async () => {
                  await logout();
                  navigate("/");
                }}
              >
                Log out
              </Button>
            </>
          ) : (
            <>
              <Link to="/login" className="text-sm text-white/90 hover:text-white">Log in</Link>
              <Button as={Link} to="/register" variant="accent">Sign up</Button>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}