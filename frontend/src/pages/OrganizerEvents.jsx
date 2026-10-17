import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import { Badge, Button, Card, ErrorBanner, Input, PageHeader, Select, SuccessBanner, TextArea } from "../components/ui";
import ImageUploader from "../components/ImageUploader";
import TicketCard from "../components/TicketCard";

const STATUS_TONE = {
  draft: "slate",
  pending_review: "warn",
  approved: "navy",
  published: "ok",
  postponed: "warn",
  cancelled: "danger",
  completed: "slate",
};

const CATEGORIES = [
  "Technology & Innovation",
  "Academic & Lecture",
  "Workshop & Training",
  "Culture & Arts",
  "Sports & Fitness",
  "Social & Entertainment",
  "Career & Networking",
  "Other Campus Event",
];

export default function OrganizerEvents() {
  const [events, setEvents] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const initialForm = {
    title: "",
    description: "",
    category: "Technology & Innovation",
    organizerName: "",
    contactInfo: "",
    dateTime: "",
    endTime: "",
    venueName: "",
    venueAddress: "",
    location: "",
    posterUrl: "",
    capacity: 100,
    ticketTypes: [
      {
        name: "Regular",
        description: "General campus admission pass",
        price: 0,
        quantityTotal: 100,
        purchaseLimit: 5,
        salesStartAt: "",
        salesEndAt: "",
      },
    ],
  };

  const [form, setForm] = useState(initialForm);

  async function load() {
    try {
      const { data } = await client.get("/events/mine");
      setEvents(data.events || []);
    } catch (err) {
      setError(errMsg(err, "Could not load events"));
    }
  }

  useEffect(() => {
    load();
  }, []);

  function updateTicketType(index, field, value) {
    const updated = [...form.ticketTypes];
    updated[index] = { ...updated[index], [field]: value };
    setForm({ ...form, ticketTypes: updated });
  }

  function addTicketType() {
    setForm({
      ...form,
      ticketTypes: [
        ...form.ticketTypes,
        {
          name: "VIP",
          description: "Priority entrance and premium seating",
          price: 50,
          quantityTotal: 25,
          purchaseLimit: 2,
          salesStartAt: "",
          salesEndAt: "",
        },
      ],
    });
  }

  function removeTicketType(index) {
    if (form.ticketTypes.length <= 1) return;
    setForm({
      ...form,
      ticketTypes: form.ticketTypes.filter((_, i) => i !== index),
    });
  }

  async function createEvent(e) {
    e.preventDefault();
    setError("");
    setSuccess("");
    try {
      await client.post("/events", {
        ...form,
        location: form.venueName || form.location || "Campus Venue",
        capacity: Number(form.capacity),
        ticketTypes: form.ticketTypes.map((t) => ({
          ...t,
          price: Number(t.price),
          quantityTotal: Number(t.quantityTotal),
          purchaseLimit: t.purchaseLimit ? Number(t.purchaseLimit) : null,
          salesStartAt: t.salesStartAt || null,
          salesEndAt: t.salesEndAt || null,
        })),
      });

      setSuccess("Event created successfully as a draft.");
      setShowForm(false);
      setForm(initialForm);
      await load();
    } catch (err) {
      setError(errMsg(err, "Could not create event"));
    }
  }

  async function submitForReview(id) {
    setError("");
    setSuccess("");
    try {
      await client.post(`/events/${id}/submit`);
      setSuccess("Event submitted for university admin review.");
      await load();
    } catch (err) {
      setError(errMsg(err, "Could not submit for review"));
    }
  }

  async function setStatus(id, status) {
    setError("");
    setSuccess("");
    try {
      await client.patch(`/events/${id}`, { status });
      setSuccess(`Event updated to ${status.replace("_", " ")}.`);
      await load();
    } catch (err) {
      setError(errMsg(err, "Could not update event"));
    }
  }

  // Generate a mock ticket object for live preview modal
  const sampleTicket = {
    id: "sample-preview-id",
    ticket_number: "GIB-DEMO2026",
    event_title: form.title || "Your Event Title",
    poster_url: form.posterUrl || null,
    category: form.category,
    organizer_name: form.organizerName || "Campus Organizer Association",
    club_name: form.organizerName || "Student Club",
    date_time: form.dateTime || new Date().toISOString(),
    end_time: form.endTime || null,
    venue_name: form.venueName || form.location || "Campus Main Hall",
    venue_address: form.venueAddress || "Block 2, Campus Grounds",
    location: form.venueName || form.location || "Campus Main Hall",
    holder_name: "Abebe Bikila",
    university_name: "Addis Ababa University",
    ticket_type: form.ticketTypes[0]?.name || "Regular",
    price: form.ticketTypes[0]?.price || 0,
    status: "active",
    qrDataUrl:
      "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 10 10'><rect width='10' height='10' fill='white'/><rect x='1' y='1' width='3' height='3' fill='black'/><rect x='6' y='1' width='3' height='3' fill='black'/><rect x='1' y='6' width='3' height='3' fill='black'/><rect x='5' y='5' width='2' height='2' fill='black'/><rect x='7' y='7' width='2' height='2' fill='black'/></svg>",
  };

  if (!events) return null;

  return (
    <div>
      <PageHeader
        title="Organizer Event Management"
        subtitle="Create campus events, customize branded ticket designs with poster graphics, configure ticket tiers, and manage check-ins."
        action={
          <Button
            variant="accent"
            onClick={() => {
              setShowForm((s) => !s);
              setError("");
              setSuccess("");
            }}
          >
            {showForm ? "✕ Close Form" : "+ Create New Event"}
          </Button>
        }
      />

      <ErrorBanner message={error} />
      <SuccessBanner message={success} />

      {/* Event Creation & Customization Card */}
      {showForm && (
        <Card className="mb-8 p-6 shadow-md border-navy/20">
          <div className="mb-4 flex items-center justify-between border-b border-slate/15 pb-3">
            <div>
              <h2 className="text-lg font-bold text-navy">New Campus Event</h2>
              <p className="text-xs text-slate">
                Fill in the details below. Upload an event poster to automatically style attendees' personalized ticket passes.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPreviewOpen(true)}
              className="text-xs"
            >
              👁️ Preview Ticket Design
            </Button>
          </div>

          <form onSubmit={createEvent} className="space-y-5">
            {/* Poster Upload & Category */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="md:col-span-1">
                <label className="block text-sm font-medium text-navy mb-1.5">
                  Event Poster / Banner Image
                </label>
                <div className="space-y-2">
                  <ImageUploader
                    value={form.posterUrl ? [form.posterUrl] : []}
                    onChange={(urls) => setForm({ ...form, posterUrl: urls[0] || "" })}
                    max={1}
                  />
                  <Input
                    placeholder="Or paste image URL"
                    value={form.posterUrl}
                    onChange={(e) => setForm({ ...form, posterUrl: e.target.value })}
                    className="text-xs"
                  />
                </div>
              </div>

              <div className="space-y-4 md:col-span-2">
                <Input
                  label="Event Title"
                  required
                  placeholder="e.g. Annual Tech Symposium & Hackathon"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Select
                    label="Category"
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                  >
                    {CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </Select>

                  <Input
                    label="Total Event Capacity"
                    type="number"
                    min="1"
                    required
                    value={form.capacity}
                    onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Input
                    label="Organizer Display Name"
                    placeholder="e.g. Robotics Club / CS Dept"
                    value={form.organizerName}
                    onChange={(e) => setForm({ ...form, organizerName: e.target.value })}
                  />

                  <Input
                    label="Contact Information"
                    placeholder="e.g. events@club.edu / +251 9..."
                    value={form.contactInfo}
                    onChange={(e) => setForm({ ...form, contactInfo: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <TextArea
              label="Description & Agenda"
              rows={3}
              placeholder="Describe the event, special guests, rules, and what attendees should bring..."
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />

            {/* Schedule & Venue */}
            <div className="rounded-xl bg-paper p-4">
              <h3 className="mb-3 text-sm font-semibold text-navy">Schedule & Venue</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Input
                  label="Start Date & Time"
                  type="datetime-local"
                  required
                  value={form.dateTime}
                  onChange={(e) => setForm({ ...form, dateTime: e.target.value })}
                />

                <Input
                  label="End Date & Time (Optional)"
                  type="datetime-local"
                  value={form.endTime}
                  onChange={(e) => setForm({ ...form, endTime: e.target.value })}
                />
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Input
                  label="Venue Name"
                  placeholder="e.g. Main Auditorium / Sports Complex"
                  required
                  value={form.venueName}
                  onChange={(e) => setForm({ ...form, venueName: e.target.value, location: e.target.value })}
                />

                <Input
                  label="Venue Address / Room Number"
                  placeholder="e.g. Engineering Block 3, 2nd Floor"
                  value={form.venueAddress}
                  onChange={(e) => setForm({ ...form, venueAddress: e.target.value })}
                />
              </div>
            </div>

            {/* Ticket Types Configuration */}
            <div className="rounded-xl border border-slate/20 p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-navy">Ticket Types & Pricing</h3>
                  <p className="text-xs text-slate">
                    Offer multiple ticket tiers (e.g. General, VIP, Student Free Pass) with separate quotas.
                  </p>
                </div>
                <Button type="button" variant="outline" onClick={addTicketType} className="text-xs">
                  + Add Ticket Tier
                </Button>
              </div>

              <div className="space-y-3">
                {form.ticketTypes.map((tt, i) => (
                  <div key={i} className="rounded-lg border border-slate/15 bg-white p-3 shadow-xs">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                      <Input
                        label="Tier Name"
                        placeholder="e.g. Regular"
                        required
                        value={tt.name}
                        onChange={(e) => updateTicketType(i, "name", e.target.value)}
                      />
                      <Input
                        label="Price (ETB, 0 = Free)"
                        type="number"
                        min="0"
                        step="0.01"
                        required
                        value={tt.price}
                        onChange={(e) => updateTicketType(i, "price", e.target.value)}
                      />
                      <Input
                        label="Quantity Total"
                        type="number"
                        min="1"
                        required
                        value={tt.quantityTotal}
                        onChange={(e) => updateTicketType(i, "quantityTotal", e.target.value)}
                      />
                      <Input
                        label="Purchase Limit / Student"
                        type="number"
                        min="1"
                        value={tt.purchaseLimit || ""}
                        onChange={(e) => updateTicketType(i, "purchaseLimit", e.target.value)}
                      />
                    </div>

                    <div className="mt-2 flex items-center justify-between gap-2">
                      <Input
                        placeholder="Description (e.g. includes refreshments & swag bag)"
                        value={tt.description || ""}
                        onChange={(e) => updateTicketType(i, "description", e.target.value)}
                        className="flex-1 text-xs"
                      />
                      {form.ticketTypes.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => removeTicketType(i)}
                          className="text-xs text-danger hover:bg-danger/10"
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => setPreviewOpen(true)}>
                👁️ Preview Ticket
              </Button>
              <Button type="submit" variant="accent">
                Save Event as Draft
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Ticket Preview Modal */}
      {previewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-paper p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between border-b border-slate/15 pb-2">
              <h3 className="font-bold text-navy">Live Attendee Ticket Preview</h3>
              <button
                type="button"
                onClick={() => setPreviewOpen(false)}
                className="rounded-full p-1 text-slate hover:bg-slate/10 hover:text-navy"
              >
                ✕
              </button>
            </div>
            <TicketCard ticket={sampleTicket} isPreview={true} showActions={false} />
            <div className="mt-4 flex justify-end">
              <Button onClick={() => setPreviewOpen(false)} variant="primary">
                Done Previewing
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Existing Events List */}
      <div className="space-y-4">
        {events.length === 0 ? (
          <Card className="p-8 text-center text-slate">
            <p className="font-medium text-navy">You have not created any events yet.</p>
            <p className="mt-1 text-sm">Click "+ Create New Event" above to get started.</p>
          </Card>
        ) : (
          events.map((ev) => (
            <Card key={ev.id} className="p-5 transition hover:shadow-md">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex gap-4">
                  {ev.poster_url ? (
                    <img
                      src={ev.poster_url}
                      alt={ev.title}
                      className="h-20 w-20 flex-shrink-0 rounded-lg object-cover border border-slate/15"
                    />
                  ) : (
                    <div className="flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-lg bg-navy/10 text-xl font-bold text-navy">
                      ግቢያችን
                    </div>
                  )}

                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-navy text-lg">{ev.title}</h3>
                      {ev.category && (
                        <span className="rounded-full bg-slate/10 px-2 py-0.5 text-[11px] font-medium text-slate">
                          {ev.category}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate mt-1">
                      📅 {new Date(ev.date_time).toLocaleString()} · 📍 {ev.venue_name || ev.location}
                    </p>
                    {ev.organizer_name && (
                      <p className="text-xs text-slate">Organizer: {ev.organizer_name}</p>
                    )}
                    {ev.reject_reason && (
                      <p className="mt-1.5 rounded-md bg-danger/10 px-2 py-1 text-xs text-danger">
                        Admin Feedback: {ev.reject_reason}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex sm:flex-col items-center sm:items-end gap-2">
                  <Badge tone={STATUS_TONE[ev.status] || "slate"}>
                    {ev.status.replaceAll("_", " ")}
                  </Badge>
                  <span className="text-xs text-slate">
                    {ev.capacity_sold || 0} / {ev.capacity} tickets sold
                  </span>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate/15 pt-3">
                <div className="flex flex-wrap gap-2">
                  {ev.status === "draft" && (
                    <Button onClick={() => submitForReview(ev.id)} variant="accent" className="text-xs">
                      Submit for Admin Approval
                    </Button>
                  )}
                  {ev.status === "approved" && (
                    <Button variant="accent" onClick={() => setStatus(ev.id, "published")} className="text-xs">
                      Publish to Campus
                    </Button>
                  )}
                  {ev.status === "published" && (
                    <>
                      <Button variant="outline" onClick={() => setStatus(ev.id, "postponed")} className="text-xs">
                        Postpone
                      </Button>
                      <Button variant="danger" onClick={() => setStatus(ev.id, "cancelled")} className="text-xs">
                        Cancel Event
                      </Button>
                    </>
                  )}
                </div>

                <Button as={Link} to={`/organizer/${ev.id}`} variant="primary" className="text-xs">
                  🎟️ Attendees, Check-in & Scanner →
                </Button>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
