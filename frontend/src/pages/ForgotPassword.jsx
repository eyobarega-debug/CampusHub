import { useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import { Button, Card, ErrorBanner, Input, PageHeader, SuccessBanner } from "../components/ui";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);
    try {
      const { data } = await client.post("/auth/forgot-password", { email });
      setMessage(data.message);
    } catch (err) {
      setError(errMsg(err, "Could not process that request"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm py-12">
      <PageHeader title="Forgot password" subtitle="We'll help you get back into your account." />
      <Card className="p-6">
        <form onSubmit={submit} className="space-y-4">
          <ErrorBanner message={error} />
          <SuccessBanner message={message} />
          <Input label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Sending..." : "Send reset link"}
          </Button>
        </form>

        <p className="mt-4 text-center text-sm text-slate">
          <Link to="/login" className="underline">Back to log in</Link>
        </p>
      </Card>
    </div>
  );
}
