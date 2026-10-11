import { useEffect, useState } from "react";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import { Badge, Button, Card, ErrorBanner, Input, PageHeader, Select, Spinner, SuccessBanner, TextArea } from "../components/ui";

const TABS = ["Merchants", "Events", "Reports & Disputes", "Users", "Clubs", "Analytics", "Audit Log"];

export default function Admin() {
  const [tab, setTab] = useState("Merchants");
  return (
    <div>
      <PageHeader title="University Administration" subtitle="Approvals, moderation, and platform oversight." />
      <div className="mb-6 flex flex-wrap gap-1 border-b border-slate/15">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium ${tab === t ? "border-b-2 border-navy text-navy" : "text-slate hover:text-navy"}`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "Merchants" && <MerchantsTab />}
      {tab === "Events" && <EventsTab />}
      {tab === "Reports & Disputes" && <ReportsTab />}
      {tab === "Users" && <UsersTab />}
      {tab === "Clubs" && <ClubsTab />}
      {tab === "Analytics" && <AnalyticsTab />}
      {tab === "Audit Log" && <AuditLogTab />}
    </div>
  );
}

function MerchantsTab() {
  const [apps, setApps] = useState(null);
  const [error, setError] = useState("");

  async function load() {
    const { data } = await client.get("/merchants/applications", { params: { status: "pending_review" } });
    setApps(data.applications);
  }
  useEffect(() => {
    load();
  }, []);

  async function decide(id, decision) {
    setError("");
    try {
      await client.patch(`/merchants/${id}/decision`, { decision });
      load();
    } catch (err) {
      setError(errMsg(err, "Could not record decision"));
    }
  }

  if (!apps) return <Spinner />;
  return (
    <div>
      <ErrorBanner message={error} />
      {apps.length === 0 ? (
        <p className="text-sm text-slate">No pending merchant applications.</p>
      ) : (
        <div className="space-y-2">
          {apps.map((a) => (
            <Card key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium text-navy">{a.business_name}</p>
                <p className="text-xs text-slate">{a.applicant_name} · {a.applicant_email} · {a.category || "No category"}</p>
              </div>
              <div className="flex gap-2">
                <Button variant="accent" onClick={() => decide(a.id, "approve")}>Approve</Button>
                <Button variant="danger" onClick={() => decide(a.id, "reject")}>Reject</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function EventsTab() {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState("");

  async function load() {
    const { data } = await client.get("/admin/events", { params: { status: "pending_review" } });
    setEvents(data.events);
  }
  useEffect(() => {
    load();
  }, []);

  async function decide(id, decision) {
    setError("");
    try {
      await client.patch(`/events/${id}/admin-decision`, { decision });
      load();
    } catch (err) {
      setError(errMsg(err, "Could not record decision"));
    }
  }

  if (!events) return <Spinner />;
  return (
    <div>
      <ErrorBanner message={error} />
      {events.length === 0 ? (
        <p className="text-sm text-slate">No events pending review.</p>
      ) : (
        <div className="space-y-2">
          {events.map((e) => (
            <Card key={e.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium text-navy">{e.title}</p>
                <p className="text-xs text-slate">{e.club_name} · {new Date(e.date_time).toLocaleString()} · {e.location}</p>
              </div>
              <div className="flex gap-2">
                <Button variant="accent" onClick={() => decide(e.id, "approve")}>Approve</Button>
                <Button variant="danger" onClick={() => decide(e.id, "reject")}>Reject</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

const ACTIONS = ["dismiss", "warn", "remove_listing", "suspend", "refund"];

function ReportsTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);

  async function load() {
    const { data } = await client.get("/admin/reports", { params: { status: "open" } });
    setData(data);
  }
  useEffect(() => {
    load();
  }, []);

  async function resolveReport(id, action) {
    setBusyId(id);
    setError("");
    try {
      await client.patch(`/admin/reports/${id}/resolve`, { resolution: `Action: ${action}`, action });
      load();
    } catch (err) {
      setError(errMsg(err, "Could not resolve report"));
    } finally {
      setBusyId(null);
    }
  }

  async function resolveDispute(id) {
    setBusyId(id);
    setError("");
    try {
      await client.patch(`/admin/disputes/${id}/resolve`, { resolution: "Reviewed by admin — see audit log" });
      load();
    } catch (err) {
      setError(errMsg(err, "Could not resolve dispute"));
    } finally {
      setBusyId(null);
    }
  }

  if (!data) return <Spinner />;
  return (
    <div className="space-y-8">
      <ErrorBanner message={error} />
      <div>
        <h2 className="mb-3 font-semibold text-navy">Open reports ({data.reports.length})</h2>
        {data.reports.length === 0 ? (
          <p className="text-sm text-slate">No open reports.</p>
        ) : (
          <div className="space-y-2">
            {data.reports.map((r) => (
              <Card key={r.id} className="p-4">
                <p className="font-medium text-navy">{r.target_type} — {r.reason}</p>
                <p className="text-xs text-slate">Reported by {r.reporter_name} · {r.details || "No further details"}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {ACTIONS.map((a) => (
                    <Button key={a} variant="outline" disabled={busyId === r.id} onClick={() => resolveReport(r.id, a)}>
                      {a.replaceAll("_", " ")}
                    </Button>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
      <div>
        <h2 className="mb-3 font-semibold text-navy">Open rental disputes ({data.disputes.length})</h2>
        {data.disputes.length === 0 ? (
          <p className="text-sm text-slate">No open disputes.</p>
        ) : (
          <div className="space-y-2">
            {data.disputes.map((d) => (
              <Card key={d.id} className="p-4">
                <p className="font-medium text-navy">{d.title}</p>
                <p className="text-xs text-slate">Raised by {d.raised_by_name}: {d.reason}</p>
                <Button className="mt-3" variant="outline" disabled={busyId === d.id} onClick={() => resolveDispute(d.id)}>
                  Mark resolved
                </Button>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function UsersTab() {
  const [q, setQ] = useState("");
  const [users, setUsers] = useState(null);
  const [error, setError] = useState("");

  async function load() {
    const { data } = await client.get("/admin/users", { params: { q: q || undefined } });
    setUsers(data.users);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function update(id, patch) {
    setError("");
    try {
      await client.patch(`/admin/users/${id}`, patch);
      load();
    } catch (err) {
      setError(errMsg(err, "Could not update user"));
    }
  }

  return (
    <div>
      <ErrorBanner message={error} />
      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
      >
        <Input placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <Button type="submit">Search</Button>
      </form>
      {!users ? (
        <Spinner />
      ) : (
        <div className="space-y-2">
          {users.map((u) => (
            <Card key={u.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium text-navy">{u.name} <span className="text-xs text-slate">({u.email})</span></p>
                <div className="mt-1 flex gap-1">
                  <Badge tone="navy">{u.role}</Badge>
                  <Badge tone={u.verified ? "ok" : "warn"}>{u.verified ? "verified" : "unverified"}</Badge>
                  {u.suspended && <Badge tone="danger">suspended</Badge>}
                </div>
              </div>
              <div className="flex gap-2">
                {!u.verified && <Button variant="outline" onClick={() => update(u.id, { verified: true })}>Verify</Button>}
                <Button variant={u.suspended ? "outline" : "danger"} onClick={() => update(u.id, { suspended: !u.suspended })}>
                  {u.suspended ? "Unsuspend" : "Suspend"}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ClubsTab() {
  const [clubs, setClubs] = useState(null);
  const [students, setStudents] = useState([]);
  const [form, setForm] = useState({ name: "", leadUserId: "" });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function load() {
    const [clubsRes, studentsRes] = await Promise.all([
      client.get("/admin/clubs"),
      client.get("/admin/users", { params: { role: "student" } }),
    ]);
    setClubs(clubsRes.data.clubs);
    setStudents(studentsRes.data.users);
  }
  useEffect(() => {
    load();
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setSuccess("");
    try {
      await client.post("/admin/clubs", form);
      setSuccess(`Club "${form.name}" registered — ${students.find((s) => s.id === form.leadUserId)?.name} is now an organizer.`);
      setForm({ name: "", leadUserId: "" });
      load();
    } catch (err) {
      setError(errMsg(err, "Could not create club"));
    }
  }

  return (
    <div>
      <Card className="mb-6 max-w-lg p-5">
        <h2 className="mb-3 font-semibold text-navy">Register a new club</h2>
        <form onSubmit={submit} className="space-y-3">
          <ErrorBanner message={error} />
          <SuccessBanner message={success} />
          <Input label="Club name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Select label="Lead / organizer" required value={form.leadUserId} onChange={(e) => setForm({ ...form, leadUserId: e.target.value })}>
            <option value="">Select a student</option>
            {students.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.email})</option>
            ))}
          </Select>
          <Button type="submit">Register club</Button>
        </form>
      </Card>

      {!clubs ? (
        <Spinner />
      ) : (
        <div className="space-y-2">
          {clubs.map((c) => (
            <Card key={c.id} className="p-4">
              <p className="font-medium text-navy">{c.name}</p>
              <p className="text-xs text-slate">Led by {c.lead_name} · {c.status}</p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function AnalyticsTab() {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    client.get("/admin/analytics").then(({ data }) => setStats(data));
  }, []);

  async function downloadCsv(type) {
    const { data } = await client.get(`/admin/reports/export?type=${type}`, { responseType: "blob" });
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${type}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!stats) return <Spinner />;
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => downloadCsv("orders")}>⬇ Export orders CSV</Button>
        <Button variant="outline" onClick={() => downloadCsv("transactions")}>⬇ Export transactions CSV</Button>
        <Button variant="outline" onClick={() => downloadCsv("users")}>⬇ Export users CSV</Button>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="Students" value={stats.usersByRole.student || 0} />
        <StatCard label="Merchants" value={stats.usersByRole.merchant || 0} />
        <StatCard label="Organizers" value={stats.usersByRole.organizer || 0} />
        <StatCard label="Stores" value={stats.storeCount} />
        <StatCard label="Orders" value={stats.orders.count} />
        <StatCard label="Completed revenue" value={`${stats.orders.completedRevenue.toFixed(0)} birr`} />
        <StatCard label="Active tickets" value={stats.activeTickets} />
        <StatCard label="Active rentals" value={stats.activeBookings} />
        <StatCard label="Active P2P listings" value={stats.activeListings} />
      </div>
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <Card className="p-4 text-center">
      <p className="text-2xl font-bold text-navy">{value}</p>
      <p className="text-xs text-slate">{label}</p>
    </Card>
  );
}

function AuditLogTab() {
  const [logs, setLogs] = useState(null);
  useEffect(() => {
    client.get("/admin/audit-logs").then(({ data }) => setLogs(data.logs));
  }, []);

  if (!logs) return <Spinner />;
  return (
    <div>
      <p className="mb-3 text-sm text-slate">
        Append-only record of sensitive actions (SRS Section 15) — approvals, moderation, refunds, and ticket scans.
      </p>
      {logs.length === 0 ? (
        <p className="text-sm text-slate">No audit entries yet.</p>
      ) : (
        <div className="space-y-1">
          {logs.map((l) => (
            <Card key={l.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
              <div>
                <span className="font-mono text-xs text-accent-dark">{l.action}</span>{" "}
                {l.target_type && <span className="text-slate">→ {l.target_type} {l.target_id?.slice(0, 8)}</span>}
              </div>
              <div className="text-xs text-slate">
                {l.actor_name || "system"} · {new Date(l.created_at).toLocaleString()}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
