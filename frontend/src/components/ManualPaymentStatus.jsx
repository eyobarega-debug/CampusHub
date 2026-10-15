import { Link } from "react-router-dom";
import { Badge, Button } from "./ui";

// Shows where a manual (pay-the-seller + screenshot) payment stands inside an order / ticket
// card, with the button the student needs next. Renders nothing for other payment types.
export default function ManualPaymentStatus({ paymentId, status, provider, rejectReason, returnTo, label }) {
  if (provider !== "manual" || !paymentId) return null;
  if (status !== "pending" && status !== "under_review") return null;

  return (
    <div className="mt-3 w-full rounded-lg bg-paper p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {status === "pending" ? (
          <div>
            <Badge tone="warn">Payment proof needed</Badge>
            {rejectReason ? (
              <p className="mt-1 text-xs text-danger">The seller rejected your last proof: {rejectReason}</p>
            ) : (
              <p className="mt-1 text-xs text-slate">Send the money to the seller, then upload your screenshot.</p>
            )}
          </div>
        ) : (
          <div>
            <Badge tone="accent">Waiting for the seller to approve</Badge>
            <p className="mt-1 text-xs text-slate">You'll be notified as soon as they confirm your payment.</p>
          </div>
        )}
        <Button as={Link} to={`/pay/manual/${paymentId}`} state={{ returnTo, label }} variant={status === "pending" ? "accent" : "outline"}>
          {status === "pending" ? "Upload proof" : "View status"}
        </Button>
      </div>
    </div>
  );
}