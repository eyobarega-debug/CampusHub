import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth, errMsg } from "../context/AuthContext";
import { Button, Card, ErrorBanner, Input, PageHeader } from "../components/ui";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const user = await login(form.email, form.password);
      const dest = location.state?.from?.pathname || roleHome(user.role);
      navigate(dest, { replace: true });
    } catch (err) {
      setError(errMsg(err, "Could not log in"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm py-12">
      <PageHeader title="Log in" subtitle="Welcome back to CampusHub." />
      <Card className="p-6">
        <form onSubmit={onSubmit} className="space-y-4">
          <ErrorBanner message={error} />
          <Input label="Email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <Input
            label="Password"
            type="password"
            required
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Logging in..." : "Log in"}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-slate">
          No account? <Link to="/register" className="font-medium text-navy underline">Sign up</Link>
        </p>
        <p className="mt-1 text-center text-sm text-slate">
          <Link to="/forgot-password" className="underline">Forgot your password?</Link>
        </p>
        <div className="mt-6 rounded-lg bg-paper p-3 text-xs text-slate">
          <p className="mb-1 font-medium text-navy">Demo accounts (password: Password123!)</p>
          <p>admin@aastu.edu.et · sara@aastu.edu.et · selam@aastu.edu.et (merchant) · robel@aastu.edu.et (organizer)</p>
        </div>
      </Card>
    </div>
  );
}

export function roleHome(role) {
  return { merchant: "/merchant", organizer: "/organizer", admin: "/admin" }[role] || "/marketplace";
}
