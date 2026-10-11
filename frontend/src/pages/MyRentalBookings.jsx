import { useEffect, useState } from "react";
import { client } from "../api/client";
import { useAuth, errMsg } from "../context/AuthContext";
import { Badge, Button, Card, EmptyState, ErrorBanner, PageHeader, Spinner, TextArea } from "../components/ui";

const STATUS_TONE = {
  pending_payment: "warn",
  confirmed_awaiting_pickup: "navy",
  active: "ok",
  overdue: "danger",
  completed: "slate",
  cancelled: "danger",
  disputed: "warn",
};

export default function MyRentalBookings() {
  const { user } = useAuth();
  const [bookings, setBookings] = useState(null);
  const [error, setError] = useState("");
  const [disputeFor, setDisputeFor] = useState(null);
  const [disputeReason, setDisputeReason] = useState("");

  async function load() {
    const { data } = await client.get("/rentals/bookings/mine");
    setBookings(data.bookings);
  }
  useEffect(() => {
    load();
  }, []);

  async function act(path, id, body) {
    setError("");
    try {
      await client.post(`/rentals/bookings/${id}/${path}`, body || {});
      await load();
    } catch (err) {
      setError(errMsg(err, "Action failed"));
    }
  }

  async function submitDispute(id) {
    await act("dispute", id, { reason: disputeReason });
    setDisputeFor(null);
    setDisputeReason("");
  }

  if (!bookings) return <div className="flex justify-center py-16"><Spinner /></div>;

  return (
    <div>
      <PageHeader title="My Rental Bookings" subtitle="As borrower and as lender — pickup, return, and disputes happen here." />
      <ErrorBanner message={error} />
      {bookings.length === 0 ? (
        <EmptyState title="No bookings yet" />
      ) : (
        <div className="space-y-3">
          {bookings.map((b) => {
            const iAmBorrower = user.id !== b.owner_id;
            return (
              <Card key={b.id} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-navy">
                      {b.title} <span className="text-xs text-slate">({iAmBorrower ? "borrowing" : "lending"})</span>
                    </p>
                    <p className="text-xs text-slate">
                      {b.start_date?.slice(0, 10)} → {b.end_date?.slice(0, 10)} · deposit status: {b.deposit_status}
                      {Number(b.late_fee) > 0 && ` · late fee ${Number(b.late_fee).toFixed(2)}`}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONE[b.status] || "slate"}>{b.status.replaceAll("_", " ")}</Badge>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {!iAmBorrower && b.status === "confirmed_awaiting_pickup" && (
                    <Button onClick={() => act("pickup", b.id)}>Confirm pickup</Button>
                  )}
                  {iAmBorrower && b.status === "confirmed_awaiting_pickup" && (
                    <Button onClick={() => act("pickup", b.id)}>Confirm pickup</Button>
                  )}
                  {!iAmBorrower && ["active", "overdue"].includes(b.status) && (
                    <Button variant="accent" onClick={() => act("return", b.id, { condition: "good" })}>
                      Confirm return
                    </Button>
                  )}
                  {["active", "overdue", "confirmed_awaiting_pickup"].includes(b.status) && (
                    <Button variant="outline" onClick={() => setDisputeFor(b.id)}>Report a problem</Button>
                  )}
                </div>

                {disputeFor === b.id && (
                  <div className="mt-3 space-y-2 border-t border-slate/15 pt-3">
                    <TextArea
                      label="What went wrong?"
                      rows={2}
                      value={disputeReason}
                      onChange={(e) => setDisputeReason(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <Button variant="danger" onClick={() => submitDispute(b.id)}>Submit dispute</Button>
                      <Button variant="ghost" onClick={() => setDisputeFor(null)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
