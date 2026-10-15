import { useEffect, useState } from "react";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import { Badge, Card, EmptyState, ErrorBanner, PageHeader, Spinner, Button } from "../components/ui";
import ManualPaymentStatus from "../components/ManualPaymentStatus";

const STATUS_TONE = {
  pending_payment: "warn",
  confirmed: "navy",
  ready: "accent",
  completed: "ok",
  cancellation_requested: "warn",
  cancelled: "danger",
};

export default function Orders() {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState("");

  async function load() {
    const { data } = await client.get("/orders");
    setOrders(data.orders);
  }

  useEffect(() => {
    load();
  }, []);

  async function cancel(o) {
    setError("");
    try {
      // An unpaid manual payment is cancelled through the payment so the seller's list updates too.
      if (o.payment_provider === "manual" && o.payment_status === "pending") {
        await client.post(`/payments/${o.payment_id}/cancel`, {});
      } else {
        await client.post(`/orders/${o.id}/cancel`, { reason: "Changed my mind" });
      }
      await load();
    } catch (err) {
      setError(errMsg(err, "Could not cancel the order"));
    }
  }

  if (!orders) return <div className="flex justify-center py-16"><Spinner /></div>;

  return (
    <div>
      <PageHeader title="My Orders" subtitle="Track every marketplace purchase from payment to pickup." />
      <ErrorBanner message={error} />
      {orders.length === 0 ? (
        <EmptyState title="No orders yet" subtitle="Browse the marketplace to make your first purchase." />
      ) : (
        <div className="space-y-3">
          {orders.map((o) => (
            <Card key={o.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium text-navy">Order #{o.id.slice(0, 8)} · {o.store_name}</p>
                <p className="text-xs text-slate">{new Date(o.created_at).toLocaleString()} · {Number(o.total_amount).toFixed(2)} birr</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={STATUS_TONE[o.status] || "slate"}>{o.status.replaceAll("_", " ")}</Badge>
                {["pending_payment", "confirmed"].includes(o.status) && o.payment_status !== "under_review" && (
                  <Button variant="outline" onClick={() => cancel(o)}>Cancel</Button>
                )}
              </div>
              {o.status === "pending_payment" && (
                <ManualPaymentStatus
                  paymentId={o.payment_id}
                  status={o.payment_status}
                  provider={o.payment_provider}
                  rejectReason={o.payment_reject_reason}
                  returnTo="/orders"
                  label={`Order #${o.id.slice(0, 8)} · ${o.store_name}`}
                />
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}