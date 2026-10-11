import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Spinner } from "./ui";

export default function ProtectedRoute({ role, children }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (role) {
    const roles = Array.isArray(role) ? role : [role];
    if (!roles.includes(user.role)) {
      return (
        <div className="mx-auto max-w-lg py-16 text-center">
          <p className="text-lg font-semibold text-navy">Not available for your role</p>
          <p className="mt-1 text-sm text-slate">This page requires: {roles.join(" or ")}.</p>
        </div>
      );
    }
  }
  return children;
}
