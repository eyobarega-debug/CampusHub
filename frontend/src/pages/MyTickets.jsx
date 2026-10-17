import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import { Badge, Button, Card, EmptyState, ErrorBanner, PageHeader, Spinner, SuccessBanner } from "../components/ui";
import TicketCard from "../components/TicketCard";

export default function MyTickets() {
  const [tickets, setTickets] = useState(null);
  const [waitlist, setWaitlist] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [filter, setFilter] = useState("all");

  async function load() {
    try {
      const [ticketsRes, waitlistRes] = await Promise.all([
        client.get("/tickets/mine"),
        client.get("/events/waitlist/mine"),
      ]);
      setTickets(ticketsRes.data.tickets || []);
      setWaitlist(waitlistRes.data.entries || []);
    } catch (err) {
      setError(errMsg(err, "Could not load tickets"));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function cancelActiveTicket(ticketId) {
    if (!window.confirm("Are you sure you want to cancel this ticket? If you paid, a refund will be processed.")) {
      return;
    }
    setError("");
    setSuccess("");
    try {
      await client.post(`/tickets/${ticketId}/cancel`, { reason: "Attendee cancellation" });
      setSuccess("Ticket cancelled successfully.");
      await load();
    } catch (err) {
      setError(errMsg(err, "Could not cancel the ticket"));
    }
  }

  async function cancelUnpaidReservation(t) {
    if (!window.confirm("Cancel this ticket reservation?")) return;
    setError("");
    setSuccess("");
    try {
      await client.post(`/payments/${t.payment_id}/cancel`, {});
      setSuccess("Reservation cancelled.");
      await load();
    } catch (err) {
      setError(errMsg(err, "Could not cancel the reservation"));
    }
  }

  if (!tickets) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const filteredTickets = tickets.filter((t) => {
    if (filter === "all") return true;
    if (filter === "active") return t.status === "active";
    if (filter === "reserved") return t.status === "reserved";
    if (filter === "used") return t.status === "used";
    if (filter === "cancelled") return t.status === "cancelled" || t.status === "expired";
    return true;
  });

  return (
    <div>
      <PageHeader
        title="My Event Tickets"
        subtitle="Your personalized passes with cryptographically signed QR codes. Present at the event entrance for admission."
      />

      <ErrorBanner message={error} />
      <SuccessBanner message={success} />

      {/* Filter Tabs */}
      {tickets.length > 0 && (
        <div className="no-print mb-6 flex flex-wrap gap-2">
          {[
            { id: "all", label: `All (${tickets.length})` },
            { id: "active", label: `Valid & Ready (${tickets.filter((t) => t.status === "active").length})` },
            { id: "reserved", label: `Pending Payment (${tickets.filter((t) => t.status === "reserved").length})` },
            { id: "used", label: `Used (${tickets.filter((t) => t.status === "used").length})` },
            { id: "cancelled", label: `Cancelled (${tickets.filter((t) => t.status === "cancelled" || t.status === "expired").length})` },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFilter(tab.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                filter === tab.id
                  ? "bg-navy text-white shadow-sm"
                  : "bg-white text-slate hover:bg-slate/10"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {tickets.length === 0 ? (
        <EmptyState
          title="No tickets yet"
          subtitle="Explore upcoming campus events and reserve your passes."
          action={
            <Button as={Link} to="/events" variant="accent" className="mt-3">
              Browse Events
            </Button>
          }
        />
      ) : filteredTickets.length === 0 ? (
        <EmptyState
          title="No tickets in this category"
          subtitle="Switch filters to view your other event passes."
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {filteredTickets.map((t) => (
            <TicketCard
              key={t.id}
              ticket={t}
              onCancel={cancelActiveTicket}
              onCancelUnpaid={cancelUnpaidReservation}
            />
          ))}
        </div>
      )}

      {waitlist && waitlist.length > 0 && (
        <div className="no-print mt-10">
          <h2 className="mb-3 font-semibold text-navy">My Waitlist Status</h2>
          <div className="space-y-2">
            {waitlist.map((w) => (
              <Card key={w.id} className="flex items-center justify-between p-4">
                <div>
                  <p className="font-medium text-navy">{w.event_title}</p>
                  <p className="text-xs text-slate">
                    {w.ticket_type} · {new Date(w.date_time).toLocaleString()}
                  </p>
                </div>
                <Badge tone={w.status === "notified" ? "accent" : "slate"}>
                  {w.status === "notified" ? "⭐ Spot available!" : "Waiting in queue"}
                </Badge>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
