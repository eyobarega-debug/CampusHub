import { useEffect, useState } from "react";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import { Badge, Button, Card, ErrorBanner, Input, PageHeader, Select, Spinner, SuccessBanner, TextArea } from "../components/ui";
import VerificationDocument from "../components/VerificationDocument";

const TABS = ["Merchants", "Events", "Reports & Disputes", "Users", "Clubs", "Verifications", "Analytics", "Audit Log"];

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
      {tab === "Verifications" && <VerificationsTab />}
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

const VERIF_DOC_LABELS = {
  student_id: "Student ID",
  university_id_card: "University ID card",
  proof_of_enrollment: "Proof of enrollment",
  other: "Other proof",
};
const VERIF_STATUS_TONES = { pending: "warn", approved: "ok", rejected: "danger" };

function VerificationsTab() {
  const [items, setItems] = useState(null);
  const [selected, setSelected] = useState(null);
  const [status, setStatus] = useState("pending");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  async function load() {
    setError("");
    try {
      const { data } = await client.get("/admin/verifications/requests", {
        params: { status, q: search || undefined },
      });
      setItems(data.requests);
    } catch (err) {
      setError(errMsg(err, "Could not load verification requests"));
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function open(r) {
    setError("");
    setSuccess("");
    setRejecting(false);
    setRejectReason("");
    setSelected(null);
    try {
      const { data } = await client.get(`/admin/verifications/requests/${r.id}`);
      setSelected(data.request);
    } catch (err) {
      setError(errMsg(err, "Could not load request details"));
    }
  }

  async function decide(action) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      if (action === "approve") {
        await client.patch(`/admin/verifications/requests/${selected.id}/approve`);
        setSuccess("Request approved — the student's account is now campus verified.");
      } else {
        await client.patch(`/admin/verifications/requests/${selected.id}/reject`, {
          rejectionReason: rejectReason.trim(),
        });
        setSuccess("Request rejected — the student will see your reason.");
      }
      setSelected(null);
      setRejecting(false);
      setRejectReason("");
      await load();
    } catch (err) {
      setError(errMsg(err, "Could not record decision"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <ErrorBanner message={error} />
      <SuccessBanner message={success} />

      <div className="flex flex-wrap items-end gap-2">
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-[180px]">
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="all">All (pending first)</option>
        </Select>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            load();
          }}
        >
          <Input
            placeholder="Search by student name or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
          />
          <Button type="submit">Search</Button>
        </form>
      </div>

      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <p className="text-sm text-slate">
          {status === "pending" ? "No pending verification requests." : "No verification requests match this filter."}
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((r) => (
            <Card
              key={r.id}
              className={`flex flex-wrap items-center justify-between gap-3 p-4 ${
                selected?.id === r.id ? "border-navy/40" : ""
              }`}
            >
              <div>
                <p className="font-medium text-navy">
                  {r.studentName} <span className="text-xs font-normal text-slate">({r.studentEmail})</span>
                </p>
                <p className="text-xs text-slate">
                  {VERIF_DOC_LABELS[r.documentType] || r.documentType} · {r.universityName} · submitted{" "}
                  {new Date(r.createdAt).toLocaleString()}
                </p>
                {r.status === "rejected" && r.rejectionReason && (
                  <p className="text-xs text-danger">Rejected: {r.rejectionReason}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={VERIF_STATUS_TONES[r.status] || "slate"}>{r.status}</Badge>
                <Button variant="outline" onClick={() => open(r)}>
                  Review
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {selected && (
        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold text-navy">Review request</h3>
              <p className="text-sm text-slate">
                {selected.studentName} · {selected.studentEmail}
                {selected.studentPhone ? ` · ${selected.studentPhone}` : ""}
              </p>
              <p className="text-xs text-slate">
                {selected.universityName} · {VERIF_DOC_LABELS[selected.documentType] || selected.documentType} ·
                submitted {new Date(selected.createdAt).toLocaleString()}
              </p>
              <div className="mt-1">
                <Badge tone={VERIF_STATUS_TONES[selected.status] || "slate"}>{selected.status}</Badge>
              </div>
            </div>
            <Button variant="ghost" onClick={() => setSelected(null)}>Close</Button>
          </div>

          {selected.studentNote && (
            <div className="mb-3 rounded-lg bg-slate/5 px-3 py-2 text-sm text-slate">
              <span className="font-medium text-navy">Student note:</span> {selected.studentNote}
            </div>
          )}
          {selected.status === "rejected" && selected.rejectionReason && (
            <div className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
              <span className="font-medium">Rejection reason:</span> {selected.rejectionReason}
            </div>
          )}
          {selected.status === "approved" && selected.reviewerName && (
            <p className="mb-3 text-xs text-slate">
              Approved by {selected.reviewerName} on {new Date(selected.reviewedAt).toLocaleString()}
            </p>
          )}

          <div className="mb-4">
            <p className="mb-2 text-sm font-medium text-navy">Submitted document</p>
            <VerificationDocument url={`/admin/verifications/requests/${selected.id}/document`} />
          </div>

          {selected.status === "pending" && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button variant="accent" disabled={busy} onClick={() => decide("approve")}>
                  {busy ? "Saving..." : "Approve verification"}
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => setRejecting((v) => !v)}
                >
                  Reject
                </Button>
              </div>
              {rejecting && (
                <div className="space-y-2 rounded-lg border border-slate/20 p-3">
                  <TextArea
                    label="Rejection reason (required)"
                    rows={3}
                    required
                    placeholder="e.g. The uploaded ID photo is unreadable"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                  />
                  <Button
                    variant="danger"
                    disabled={busy || rejectReason.trim().length < 2}
                    onClick={() => decide("reject")}
                  >
                    Confirm rejection
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>
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
