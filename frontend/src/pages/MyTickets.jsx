import { useEffect, useState } from "react";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import { Badge, Button, Card, EmptyState, ErrorBanner, PageHeader, Spinner } from "../components/ui";import ManualPaymentStatus from "../components/ManualPaymentStatus";
const STATUS_TONE = { reserved: "warn", active: "ok", used: "slate", cancelled: "danger", expired: "danger" };

export default function MyTickets() {
  const [tickets, setTickets] = useState(null);
  const [waitlist, setWaitlist] = useState(null);
  const [error, setError] = useState("");

  async function load() {
    const [ticketsRes, waitlistRes] = await Promise.all([
      client.get("/tickets/mine"),
      client.get("/events/waitlist/mine"),
    ]);
    setTickets(ticketsRes.data.tickets);
    setWaitlist(waitlistRes.data.entries);
  }
  useEffect(() => {
    load();
  }, []);

   async function cancelUnpaid(t) {
    setError("");
    try {
      await client.post(`/payments/${t.payment_id}/cancel`, {});
      await load();
    } catch (err) {
      setError(errMsg(err, "Could not cancel the reservation"));
    }
  }

  if (!tickets) return <div className="flex justify-center py-16"><Spinner /></div>;

  return (
    <div>
      <PageHeader title="My Tickets" subtitle="Present the QR code at the door — it's single-use and tied to this event only." />
      <ErrorBanner message={error} />
      {tickets.length === 0 ? (
        <EmptyState title="No tickets yet" subtitle="Buy a ticket from the Events page." />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {tickets.map((t) => (
            <Card key={t.id} className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium text-navy">{t.event_title}</p>
                  <p className="text-xs text-slate">{new Date(t.date_time).toLocaleString()} · {t.location}</p>
                  <p className="text-xs text-slate">{t.ticket_type} · {Number(t.price).toFixed(2)} birr</p>
                </div>
                <Badge tone={STATUS_TONE[t.status] || "slate"}>{t.status}</Badge>
              </div>

              {t.status === "active" && t.qrDataUrl && (
                <div className="mt-4 flex flex-col items-center gap-2 rounded-lg bg-paper p-4">
                  <img src={t.qrDataUrl} alt="Ticket QR code" className="h-40 w-40" />
                  <p className="text-center text-xs text-slate">Signed, single-use — scanned once, it can't be used again.</p>
                  <Button variant="outline" className="mt-2" onClick={() => cancel(t.id)}>Cancel ticket</Button>
                </div>
              )}
                            {t.status === "reserved" && (
                <>
                  <ManualPaymentStatus
                    paymentId={t.payment_id}
                    status={t.payment_status}
                    provider={t.payment_provider}
                    rejectReason={t.payment_reject_reason}
                    returnTo="/tickets"
                    label={`Ticket: ${t.event_title}`}
                  />
                  {t.payment_status === "pending" && t.payment_provider === "manual" && (
                    <Button variant="ghost" className="mt-2" onClick={() => cancelUnpaid(t)}>Cancel reservation</Button>
                  )}
                </>
              )}
            </Card>
          ))}
        </div>
      )}

      {waitlist && waitlist.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 font-semibold text-navy">My Waitlist</h2>
          <div className="space-y-2">
            {waitlist.map((w) => (
              <Card key={w.id} className="flex items-center justify-between p-4">
                <div>
                  <p className="font-medium text-navy">{w.event_title}</p>
                  <p className="text-xs text-slate">{w.ticket_type} · {new Date(w.date_time).toLocaleString()}</p>
                </div>
                <Badge tone={w.status === "notified" ? "accent" : "slate"}>
                  {w.status === "notified" ? "⭐ Spot available!" : "waiting"}
                </Badge>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
