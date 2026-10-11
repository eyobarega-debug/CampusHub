import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import { Badge, Button, Card, ErrorBanner, Input, PageHeader, Select, TextArea } from "../components/ui";

const STATUS_TONE = {
  draft: "slate",
  pending_review: "warn",
  approved: "navy",
  published: "ok",
  postponed: "warn",
  cancelled: "danger",
  completed: "slate",
};

export default function OrganizerEvents() {
  const [events, setEvents] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    title: "",
    description: "",
    dateTime: "",
    location: "",
    capacity: 100,
    ticketTypes: [{ name: "General", price: 0, quantityTotal: 100 }],
  });

  async function load() {
    const { data } = await client.get("/events/mine");
    setEvents(data.events);
  }
  useEffect(() => {
    load();
  }, []);

  function updateTicketType(i, field, value) {
    const tt = [...form.ticketTypes];
    tt[i] = { ...tt[i], [field]: value };
    setForm({ ...form, ticketTypes: tt });
  }

  async function createEvent(e) {
    e.preventDefault();
    setError("");
    try {
      await client.post("/events", {
        ...form,
        capacity: Number(form.capacity),
        ticketTypes: form.ticketTypes.map((t) => ({ ...t, price: Number(t.price), quantityTotal: Number(t.quantityTotal) })),
      });
      setShowForm(false);
      setForm({ title: "", description: "", dateTime: "", location: "", capacity: 100, ticketTypes: [{ name: "General", price: 0, quantityTotal: 100 }] });
      await load();
    } catch (err) {
      setError(errMsg(err, "Could not create event"));
    }
  }

  async function submitForReview(id) {
    try {
      await client.post(`/events/${id}/submit`);
      await load();
    } catch (err) {
      setError(errMsg(err, "Could not submit for review"));
    }
  }

  async function setStatus(id, status) {
    try {
      await client.patch(`/events/${id}`, { status });
      await load();
    } catch (err) {
      setError(errMsg(err, "Could not update event"));
    }
  }

  if (!events) return null;

  return (
    <div>
      <PageHeader
        title="Organizer Dashboard"
        subtitle="Create events, submit for admin approval, publish, and track ticket sales."
        action={<Button variant="accent" onClick={() => setShowForm((s) => !s)}>{showForm ? "Cancel" : "+ New event"}</Button>}
      />
      <ErrorBanner message={error} />

      {showForm && (
        <Card className="mb-6 p-6">
          <form onSubmit={createEvent} className="space-y-4">
            <Input label="Title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <TextArea label="Description" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Date & time" type="datetime-local" required value={form.dateTime} onChange={(e) => setForm({ ...form, dateTime: e.target.value })} />
              <Input label="Location" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            </div>
            <Input label="Total capacity" type="number" min="1" required value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />

            <div>
              <p className="mb-2 text-sm font-medium text-navy">Ticket types</p>
              {form.ticketTypes.map((tt, i) => (
                <div key={i} className="mb-2 grid grid-cols-3 gap-2">
                  <Input placeholder="Name" value={tt.name} onChange={(e) => updateTicketType(i, "name", e.target.value)} />
                  <Input placeholder="Price" type="number" min="0" value={tt.price} onChange={(e) => updateTicketType(i, "price", e.target.value)} />
                  <Input placeholder="Quantity" type="number" min="1" value={tt.quantityTotal} onChange={(e) => updateTicketType(i, "quantityTotal", e.target.value)} />
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                onClick={() => setForm({ ...form, ticketTypes: [...form.ticketTypes, { name: "", price: 0, quantityTotal: 50 }] })}
              >
                + Add ticket type
              </Button>
            </div>
            <Button type="submit" variant="accent">Save as draft</Button>
          </form>
        </Card>
      )}

      <div className="space-y-3">
        {events.map((ev) => (
          <Card key={ev.id} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium text-navy">{ev.title}</p>
                <p className="text-xs text-slate">{new Date(ev.date_time).toLocaleString()} · {ev.location}</p>
                {ev.reject_reason && <p className="text-xs text-danger">Feedback: {ev.reject_reason}</p>}
              </div>
              <Badge tone={STATUS_TONE[ev.status] || "slate"}>{ev.status.replaceAll("_", " ")}</Badge>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {ev.status === "draft" && <Button onClick={() => submitForReview(ev.id)}>Submit for approval</Button>}
              {ev.status === "approved" && <Button variant="accent" onClick={() => setStatus(ev.id, "published")}>Publish</Button>}
              {ev.status === "published" && (
                <>
                  <Button variant="outline" onClick={() => setStatus(ev.id, "postponed")}>Postpone</Button>
                  <Button variant="danger" onClick={() => setStatus(ev.id, "cancelled")}>Cancel event</Button>
                </>
              )}
              <Button as={Link} to={`/organizer/${ev.id}`} variant="outline">Attendees & scan</Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
