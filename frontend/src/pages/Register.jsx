import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import { Button, Card, ErrorBanner, Input, PageHeader, Select, SuccessBanner } from "../components/ui";

export default function Register() {
  const navigate = useNavigate();
  const [universities, setUniversities] = useState([]);
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "", role: "student", universityId: "" });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    client.get("/meta/universities").then(({ data }) => setUniversities(data.universities));
  }, []);

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      const { data } = await client.post("/auth/register", { ...form, universityId: form.universityId || undefined });
      // Next step is email OTP verification. Stash the email so a refresh
      // doesn't strand the student, then hand off to the verification page.
      sessionStorage.setItem("ch_pending_verify_email", form.email);
      setSuccess(data.message);
      setTimeout(
        () =>
          navigate("/verify-email", {
            state: {
              email: form.email,
              expiresInSeconds: data.expiresInSeconds,
              resendCooldownSeconds: data.resendCooldownSeconds,
              devOtp: data.devOtp,
            },
          }),
        1400
      );
    } catch (err) {
      setError(errMsg(err, "Could not register"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm py-12">
      <PageHeader title="Create your account" subtitle="Join ግቢያችን (Gibiyachin) as a student or apply as a merchant later." />
      <Card className="p-6">
        <form onSubmit={onSubmit} className="space-y-4">
          <ErrorBanner message={error} />
          <SuccessBanner message={success} />
          <Input label="Full name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input
            label="Email"
            type="email"
            required
            placeholder="you@aastu.edu.et"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <Input label="Phone (optional)" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <Select label="University" value={form.universityId} onChange={(e) => setForm({ ...form, universityId: e.target.value })}>
            <option value="">Select your university</option>
            {universities.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </Select>
          <p className="-mt-2 text-xs text-slate">
            Using your university email auto-verifies you (FR-002). Otherwise an admin reviews your account.
          </p>
          <Input
            label="Password"
            type="password"
            required
            minLength={8}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Creating account..." : "Create account"}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-slate">
          Already have an account? <Link to="/login" className="font-medium text-navy underline">Log in</Link>
        </p>
      </Card>
    </div>
  );
}
