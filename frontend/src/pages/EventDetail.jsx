import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { client } from "../api/client";
import { useAuth, errMsg } from "../context/AuthContext";
import { Badge, Button, Card, EmptyState, ErrorBanner, PageHeader, Spinner, SuccessBanner } from "../components/ui";
import { PAYMENT_METHOD, startCheckout } from "../api/checkout";

export default function EventDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [ticketTypes, setTicketTypes] = useState([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [waitlisted, setWaitlisted] = useState({});

  async function load() {
    setLoading(true);
    setLoadError("");
    try {
      const { data } = await client.get(`/events/${id}`);
      setEvent(data.event);
      setTicketTypes(data.ticketTypes);
    } catch (err) {
      if (err?.response?.status === 404) {
        setLoadError("This event was not found or is not available at your campus.");
      } else {
        setLoadError(errMsg(err, "Could not load this event."));
      }
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function buy(ticketTypeId) {
    setError("");
    setBusyId(ticketTypeId);
    try {
      const { data } = await client.post(`/events/${id}/tickets`, { ticketTypeId, paymentMethod: PAYMENT_METHOD });
      startCheckout(navigate, data.payment, { returnTo: "/tickets", label: `Ticket: ${event.title}` });
    } catch (err) {
      setError(errMsg(err, "Could not reserve ticket"));
      setBusyId(null);
    }
  }

  async function joinWaitlist(ticketTypeId) {
    setError("");
    setSuccess("");
    try {
      await client.post(`/events/${id}/waitlist`, { ticketTypeId });
      setWaitlisted({ ...waitlisted, [ticketTypeId]: true });
      setSuccess("You're on the waitlist — we'll notify you if a spot opens up.");
    } catch (err) {
      setError(errMsg(err, "Could not join waitlist"));
    }
  }

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>;
  if (loadError || !event) {
    return (
      <div className="mx-auto max-w-lg py-12 text-center">
        <EmptyState
          title="Event Unavailable"
          subtitle={loadError || "This event was not found or is not available at your campus."}
          action={
            <Button as={Link} to="/events" variant="primary" className="mt-4">
              Back to Events
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={event.title}
        subtitle={`${event.organizer_name || event.club_name} · ${new Date(event.date_time).toLocaleString()} · ${event.venue_name || event.location}`}
      />
      <Card className="overflow-hidden">
        {event.poster_url && (
          <div className="h-64 w-full overflow-hidden bg-navy/10">
            <img src={event.poster_url} alt={event.title} className="h-full w-full object-cover" />
          </div>
        )}

        <div className="p-6">
          <ErrorBanner message={error} />
          <SuccessBanner message={success} />

          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate/15 pb-3">
            <div>
              <span className="text-xs font-semibold text-slate uppercase">Organizer:</span>{" "}
              <span className="text-xs font-bold text-navy">{event.organizer_name || event.club_name}</span>
              {event.contact_info && <p className="text-xs text-slate">Contact: {event.contact_info}</p>}
            </div>
            {event.category && (
              <span className="rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent-dark">
                {event.category}
              </span>
            )}
          </div>

          <div className="mb-4 rounded-xl bg-paper p-3 text-xs text-slate">
            <p className="font-semibold text-navy">📍 Venue & Location:</p>
            <p className="font-medium text-navy">{event.venue_name || event.location}</p>
            {event.venue_address && <p>{event.venue_address}</p>}
            {event.end_time && (
              <p className="mt-1">
                ⏱️ Ends at: {new Date(event.end_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </p>
            )}
          </div>

          <p className="text-sm text-slate">{event.description}</p>

          <div className="mt-6 space-y-3">
            <h3 className="font-semibold text-navy">Available Ticket Tiers</h3>
            {ticketTypes.map((tt) => {
              const soldOut = tt.quantity_sold >= tt.quantity_total;
              return (
                <div key={tt.id} className="flex items-center justify-between rounded-lg border border-slate/15 p-4">
                  <div>
                    <p className="font-medium text-navy">{tt.name}</p>
                    {tt.description && <p className="text-xs text-slate">{tt.description}</p>}
                    <p className="text-xs font-semibold text-accent-dark">
                      {Number(tt.price) > 0 ? `${Number(tt.price).toFixed(2)} ETB` : "FREE ADMISSION"} · {tt.quantity_total - tt.quantity_sold} left
                    </p>
                  </div>
                {soldOut ? (
                  user?.role === "student" ? (
                    waitlisted[tt.id] ? (
                      <Badge tone="ok">On waitlist</Badge>
                    ) : (
                      <Button variant="outline" onClick={() => joinWaitlist(tt.id)}>Join waitlist</Button>
                    )
                  ) : (
                    <Badge tone="danger">Sold out</Badge>
                  )
                ) : user?.role === "student" ? (
                  <Button variant="accent" disabled={busyId === tt.id} onClick={() => buy(tt.id)}>
                    {busyId === tt.id ? "Reserving..." : "Buy ticket"}
                  </Button>
                ) : (
                  <span className="text-xs text-slate">Log in as a student to buy</span>
                )}
              </div>
            );
          })}
        </div>
        </div>
      </Card>
    </div>
  );
}
