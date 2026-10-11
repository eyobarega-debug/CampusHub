import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import { Button, Card, ErrorBanner, Input, PageHeader, SuccessBanner } from "../components/ui";

export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [token, setToken] = useState(params.get("token") || "");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await client.post("/auth/reset-password", { token, newPassword });
      setSuccess("Password updated. All previous sessions were signed out for security.");
      setTimeout(() => navigate("/login"), 2000);
    } catch (err) {
      setError(errMsg(err, "Could not reset password — the link may have expired"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm py-12">
      <PageHeader title="Reset password" subtitle="Choose a new password for your account." />
      <Card className="p-6">
        <form onSubmit={submit} className="space-y-4">
          <ErrorBanner message={error} />
          <SuccessBanner message={success} />
          <Input label="Reset token" required value={token} onChange={(e) => setToken(e.target.value)} />
          <Input
            label="New password"
            type="password"
            required
            minLength={8}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Saving..." : "Reset password"}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-slate">
          <Link to="/login" className="underline">Back to log in</Link>
        </p>
      </Card>
    </div>
  );
}
