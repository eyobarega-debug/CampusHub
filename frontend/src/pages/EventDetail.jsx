import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { client } from "../api/client";
import { useAuth, errMsg } from "../context/AuthContext";
import { Badge, Button, Card, ErrorBanner, PageHeader, Spinner, SuccessBanner } from "../components/ui";
import { PAYMENT_METHOD, startCheckout } from "../api/checkout";

export default function EventDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [event, setEvent] = useState(null);
  const [ticketTypes, setTicketTypes] = useState([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [waitlisted, setWaitlisted] = useState({});

  async function load() {
    const { data } = await client.get(`/events/${id}`);
    setEvent(data.event);
    setTicketTypes(data.ticketTypes);
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

  if (!event) return <div className="flex justify-center py-16"><Spinner /></div>;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={event.title} subtitle={`${event.club_name} · ${new Date(event.date_time).toLocaleString()} · ${event.location}`} />
      <Card className="p-6">
        <ErrorBanner message={error} />
        <SuccessBanner message={success} />
        <p className="text-sm text-slate">{event.description}</p>

        <div className="mt-6 space-y-3">
          {ticketTypes.map((tt) => {
            const soldOut = tt.quantity_sold >= tt.quantity_total;
            return (
              <div key={tt.id} className="flex items-center justify-between rounded-lg border border-slate/15 p-4">
                <div>
                  <p className="font-medium text-navy">{tt.name}</p>
                  <p className="text-sm text-slate">{Number(tt.price).toFixed(2)} birr · {tt.quantity_total - tt.quantity_sold} left</p>
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
      </Card>
    </div>
  );
}
