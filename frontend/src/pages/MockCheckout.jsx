import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import { Button, Card, ErrorBanner, PageHeader } from "../components/ui";

export default function MockCheckout() {
  const { paymentId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { amount, returnTo, label } = location.state || {};
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function complete(outcome) {
    setError("");
    setLoading(true);
    try {
      await client.post(`/payments/mock/${paymentId}/complete`, { outcome });
      navigate(returnTo || "/", { state: { paidOutcome: outcome } });
    } catch (err) {
      setError(errMsg(err, "Payment could not be processed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-md py-16">
      <PageHeader title="Mock Checkout" subtitle="Standing in for a real Ethiopian payment provider (SRS Section 16)." />
      <Card className="p-6 text-center">
        <ErrorBanner message={error} />
        <p className="mb-1 text-sm text-slate">You're paying for</p>
        <p className="mb-1 text-lg font-semibold text-navy">{label || "Gibiyachin order"}</p>
        {amount != null && <p className="mb-6 text-3xl font-bold text-accent">{Number(amount).toFixed(2)} birr</p>}
        <div className="flex flex-col gap-3">
          <Button variant="accent" disabled={loading} onClick={() => complete("success")}>
            {loading ? "Processing..." : "✅ Simulate successful payment"}
          </Button>
          <Button variant="outline" disabled={loading} onClick={() => complete("fail")}>
            ❌ Simulate failed payment
          </Button>
        </div>
        <p className="mt-6 text-xs text-slate">
          In production this screen is the payment provider's own hosted checkout; ግቢያችን only ever
          learns the result via a signed webhook (Section 16.2), never by trusting the browser directly.
        </p>
      </Card>
    </div>
  );
}
