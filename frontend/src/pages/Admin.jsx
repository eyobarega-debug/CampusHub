import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../api/client";
import { useAuth, errMsg } from "../context/AuthContext";
import { Badge, Button, Card, ErrorBanner, Input, PageHeader, Select, Spinner, SuccessBanner, TextArea } from "../components/ui";
import VerificationDocument from "../components/VerificationDocument";
import ProofImage from "../components/ProofImage";

const TABS = [
  "Merchants",
  "Events",
  "Event Payments",
  "Organizer Payouts",
  "Commission Payments",
  "Receiving Accounts",
  "Reports & Disputes",
  "Users",
  "Clubs",
  "Verifications",
  "Analytics",
  "Audit Log",
];

export default function Admin() {
  const { user } = useAuth();
  const [tab, setTab] = useState("Merchants");

  if (user?.role === "super_admin") {
    return (
      <div className="mx-auto max-w-2xl py-8">
        <PageHeader
          title="Platform Administration"
          subtitle="Super Administrator System Oversight"
        />
        <Card className="p-8 text-center space-y-4">
          <div className="text-4xl">🌐</div>
          <h2 className="text-xl font-bold text-navy">Platform Superadmin Overview</h2>
          <p className="text-sm text-slate max-w-md mx-auto">
            You are logged in as a platform-level Super Administrator. Campus-specific administrative consoles (merchants, events, clubs, verifications, and disputes) are scoped to individual universities and require a campus administrator account.
          </p>
          <div className="rounded-lg bg-navy/5 p-4 text-xs text-slate max-w-md mx-auto space-y-1 text-left">
            <p className="font-semibold text-navy">Platform Superadmin Controls:</p>
            <p>• Multi-campus university management via <code className="bg-white px-1 py-0.5 rounded border border-slate/20">/api/super/universities</code></p>
            <p>• Global platform metrics via <code className="bg-white px-1 py-0.5 rounded border border-slate/20">/api/super/stats</code></p>
            <p>• Platform-wide audit trails via <code className="bg-white px-1 py-0.5 rounded border border-slate/20">/api/super/audit-logs</code></p>
          </div>
          <div className="pt-2">
            <Button as={Link} to="/marketplace" variant="primary">
              Return to Marketplace
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const campusSubtitle = user?.university_name
    ? `Managing ${user.university_name} — Approvals, moderation, and campus oversight.`
    : "Approvals, moderation, and platform oversight.";

  return (
    <div>
      <PageHeader title="University Administration" subtitle={campusSubtitle} />
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
      {tab === "Event Payments" && <EventPaymentsTab />}
      {tab === "Organizer Payouts" && <OrganizerPayoutsTab />}
      {tab === "Commission Payments" && <CommissionPaymentsTab />}
      {tab === "Receiving Accounts" && <ReceivingAccountsTab />}
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

function EventPaymentsTab() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [openImgId, setOpenImgId] = useState(null);
  const [rejectId, setRejectId] = useState(null);
  const [rejectReason, setRejectReason] = useState("");
  const [cancelPayment, setCancelPayment] = useState(false);

  async function load() {
    try {
      const { data } = await client.get("/admin/events/tickets/pending");
      setItems(data.tickets || []);
    } catch (err) {
      setError(errMsg(err, "Could not load pending ticket payments"));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function decide(paymentId, action, body) {
    setError("");
    setSuccess("");
    setBusyId(paymentId);
    try {
      await client.post(`/payments/${paymentId}/${action}`, body || {});
      setSuccess(action === "approve" ? "Ticket payment approved! Ticket issued and organizer balance updated." : "Payment rejected.");
      setRejectId(null);
      setRejectReason("");
      load();
    } catch (err) {
      setError(errMsg(err, `Could not ${action} payment`));
    } finally {
      setBusyId(null);
    }
  }

  if (!items) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-navy/5 p-4 text-xs text-slate">
        <p className="font-semibold text-navy">Admin Event Ticket Approval Queue</p>
        <p>
          Students pay CampusHub's receiving account for event tickets. Verify the transaction reference in your bank/Telebirr account before approving.
          Approving issues the active ticket QR code, retains CampusHub's 2.5% platform commission, and attributes 97.5% net payable to the event organizer.
        </p>
      </div>

      <ErrorBanner message={error} />
      <SuccessBanner message={success} />

      {items.length === 0 ? (
        <p className="text-sm text-slate">No ticket payments pending review.</p>
      ) : (
        <div className="space-y-3">
          {items.map((t) => (
            <Card key={t.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-navy">{t.event_title}</p>
                  <p className="text-xs text-slate">
                    Buyer: {t.student_name} ({t.student_email}) · {t.quantity}x {t.ticket_type_name}
                  </p>
                  <p className="text-xs text-slate mt-1">
                    Submitted: {new Date(t.created_at).toLocaleString()}
                  </p>
                  <p className="text-sm font-mono text-navy mt-1">
                    Ref: <strong>{t.reference_number || "None"}</strong>
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-bold text-accent-dark">{Number(t.amount).toFixed(2)} birr</p>
                  <Badge tone="warn">Awaiting Admin Approval</Badge>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 border-t border-slate/15 pt-3">
                <Button variant="outline" onClick={() => setOpenImgId(openImgId === t.payment_id ? null : t.payment_id)}>
                  {openImgId === t.payment_id ? "Hide screenshot" : "View screenshot"}
                </Button>
                <Button
                  variant="accent"
                  disabled={busyId === t.payment_id}
                  onClick={() => window.confirm(`Confirm receipt of ${Number(t.amount).toFixed(2)} birr from ${t.student_name}?`) && decide(t.payment_id, "approve")}
                >
                  Approve Ticket
                </Button>
                <Button
                  variant="danger"
                  disabled={busyId === t.payment_id}
                  onClick={() => setRejectId(rejectId === t.payment_id ? null : t.payment_id)}
                >
                  Reject
                </Button>
              </div>

              {openImgId === t.payment_id && (
                <div className="mt-3">
                  <ProofImage paymentId={t.payment_id} />
                </div>
              )}

              {rejectId === t.payment_id && (
                <div className="mt-3 space-y-2 rounded-lg bg-paper p-3">
                  <Input
                    label="Rejection Reason"
                    placeholder="e.g. Reference number not found or amount incorrect"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                  />
                  <label className="flex items-center gap-2 text-xs text-slate">
                    <input type="checkbox" checked={cancelPayment} onChange={(e) => setCancelPayment(e.target.checked)} />
                    Cancel order completely (otherwise attendee can re-upload proof)
                  </label>
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      disabled={busyId === t.payment_id || rejectReason.trim().length < 3}
                      onClick={() => decide(t.payment_id, "reject", { reason: rejectReason.trim(), cancelPayment })}
                    >
                      Confirm Rejection
                    </Button>
                    <Button variant="ghost" onClick={() => setRejectId(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function OrganizerPayoutsTab() {
  const [organizers, setOrganizers] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [payingOrg, setPayingOrg] = useState(null);
  const [payoutForm, setPayoutForm] = useState({ amount: "", referenceNumber: "", notes: "" });
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [orgsRes, histRes] = await Promise.all([
        client.get("/admin/payouts/organizers"),
        client.get("/admin/payouts/history"),
      ]);
      setOrganizers(orgsRes.data.organizers || []);
      setHistory(histRes.data.payouts || []);
    } catch (err) {
      setError(errMsg(err, "Could not load organizer payouts"));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleRecordPayout(e) {
    e.preventDefault();
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      await client.post(`/admin/payouts/organizers/${payingOrg.organizer_id}`, {
        amount: Number(payoutForm.amount),
        referenceNumber: payoutForm.referenceNumber.trim(),
        notes: payoutForm.notes.trim() || undefined,
      });
      setSuccess(`Payout of ${Number(payoutForm.amount).toFixed(2)} birr recorded for ${payingOrg.organizer_name}.`);
      setPayingOrg(null);
      setPayoutForm({ amount: "", referenceNumber: "", notes: "" });
      load();
    } catch (err) {
      setError(errMsg(err, "Could not record payout"));
    } finally {
      setBusy(false);
    }
  }

  if (!organizers) return <Spinner />;

  return (
    <div className="space-y-6">
      <div className="rounded-lg bg-navy/5 p-4 text-xs text-slate">
        <p className="font-semibold text-navy">Organizer Payout Settlements (SRS Section 8)</p>
        <p>
          CampusHub retains a 2.5% platform commission on event ticket sales. The remaining 97.5% net payable is held by CampusHub
          until paid out to the organizer's verified payout account. Record external bank/Telebirr transfers here.
        </p>
      </div>

      <ErrorBanner message={error} />
      <SuccessBanner message={success} />

      {payingOrg && (
        <Card className="p-5 border-navy/30 bg-paper">
          <h3 className="font-semibold text-navy">Record Payout to {payingOrg.organizer_name}</h3>
          <p className="text-xs text-slate mb-3">
            Available net balance: <strong>{Number(payingOrg.current_balance).toFixed(2)} birr</strong> · Email: {payingOrg.organizer_email}
          </p>

          {payingOrg.payout_accounts && payingOrg.payout_accounts.length > 0 && (
            <div className="mb-4 space-y-1">
              <p className="text-xs font-semibold text-navy">Organizer's Registered Payout Accounts:</p>
              {payingOrg.payout_accounts.map((acc) => (
                <div key={acc.id} className="text-xs bg-white rounded border border-slate/20 p-2">
                  <span className="font-semibold">{acc.account_name}</span> ({acc.method}) · <span className="font-mono">{acc.account_number}</span>
                  {acc.instructions && <span className="text-slate ml-2">— {acc.instructions}</span>}
                </div>
              ))}
            </div>
          )}

          <form onSubmit={handleRecordPayout} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label="Payout Amount (ETB)"
                type="number"
                step="0.01"
                min="1"
                max={payingOrg.current_balance}
                required
                value={payoutForm.amount}
                onChange={(e) => setPayoutForm({ ...payoutForm, amount: e.target.value })}
              />
              <Input
                label="Bank / Transfer Reference"
                required
                placeholder="e.g. TXN98765432"
                value={payoutForm.referenceNumber}
                onChange={(e) => setPayoutForm({ ...payoutForm, referenceNumber: e.target.value })}
              />
            </div>
            <TextArea
              label="Notes (optional)"
              rows={2}
              value={payoutForm.notes}
              onChange={(e) => setPayoutForm({ ...payoutForm, notes: e.target.value })}
            />
            <div className="flex gap-2">
              <Button type="submit" variant="accent" disabled={busy}>
                {busy ? "Recording..." : "Confirm & Record Payout"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setPayingOrg(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {organizers.length === 0 ? (
        <p className="text-sm text-slate">No event organizers with ticket sales found.</p>
      ) : (
        <div className="space-y-3">
          {organizers.map((o) => (
            <Card key={o.organizer_id} className="p-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-navy">{o.organizer_name}</p>
                <p className="text-xs text-slate">{o.organizer_email}</p>
                <div className="mt-2 flex flex-wrap gap-4 text-xs">
                  <span>Gross Sales: <strong>{Number(o.total_sales).toFixed(2)} birr</strong></span>
                  <span>CampusHub 2.5%: <strong className="text-accent-dark">{Number(o.platform_commission).toFixed(2)} birr</strong></span>
                  <span>Net Payable: <strong>{Number(o.net_payable).toFixed(2)} birr</strong></span>
                  <span>Paid Out: <strong className="text-ok">{Number(o.paid_out).toFixed(2)} birr</strong></span>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xs text-slate">Current Balance Due</p>
                <p className="text-xl font-bold text-warn">{Number(o.current_balance).toFixed(2)} birr</p>
                {Number(o.current_balance) > 0 && (
                  <Button
                    variant="accent"
                    className="mt-2"
                    onClick={() => {
                      setPayingOrg(o);
                      setPayoutForm({ amount: String(o.current_balance), referenceNumber: "", notes: "" });
                    }}
                  >
                    Record Payout
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <div className="mt-8">
          <h3 className="font-semibold text-navy mb-3">Recent Payout History</h3>
          <div className="space-y-2">
            {history.map((h) => (
              <Card key={h.id} className="p-3 text-xs flex flex-wrap justify-between items-center gap-2">
                <div>
                  <span className="font-semibold text-navy">{h.organizer_name}</span> · Ref: <span className="font-mono">{h.reference_number}</span>
                  {h.notes && <p className="text-slate mt-0.5">{h.notes}</p>}
                </div>
                <div className="text-right">
                  <span className="font-bold text-ok">{Number(h.amount).toFixed(2)} birr</span>
                  <p className="text-slate">{new Date(h.created_at).toLocaleDateString()} by {h.recorded_by_name}</p>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CommissionProofImage({ paymentId }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url;
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    client
      .get(`/commissions/payments/${paymentId}/image`, { responseType: "blob" })
      .then(({ data }) => {
        if (cancelled) return;
        url = URL.createObjectURL(data);
        setSrc(url);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [paymentId]);

  if (failed) return <p className="text-sm text-danger">Could not load receipt screenshot.</p>;
  if (!src) return <Spinner />;
  return (
    <a href={src} target="_blank" rel="noreferrer" title="Open full size">
      <img src={src} alt="Commission receipt screenshot" className="max-h-80 rounded-lg border border-slate/20 object-contain" />
    </a>
  );
}

function CommissionPaymentsTab() {
  const [payments, setPayments] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [openImgId, setOpenImgId] = useState(null);
  const [rejectId, setRejectId] = useState(null);
  const [rejectReason, setRejectReason] = useState("");

  async function load() {
    try {
      const { data } = await client.get("/commissions/admin/payments");
      setPayments(data.payments || []);
    } catch (err) {
      setError(errMsg(err, "Could not load merchant commission payments"));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function verify(id) {
    if (!window.confirm("Verify that this commission payment has been received in CampusHub's receiving account?")) return;
    setError("");
    setSuccess("");
    setBusyId(id);
    try {
      const { data } = await client.post(`/commissions/admin/payments/${id}/verify`, {});
      setSuccess(`Commission payment verified! Settled ${data.settledCount} due commission entries totalling ${Number(data.amount).toFixed(2)} birr.`);
      load();
    } catch (err) {
      setError(errMsg(err, "Could not verify payment"));
    } finally {
      setBusyId(null);
    }
  }

  async function reject(id) {
    if (!rejectReason.trim()) return;
    setError("");
    setSuccess("");
    setBusyId(id);
    try {
      await client.post(`/commissions/admin/payments/${id}/reject`, { reason: rejectReason.trim() });
      setSuccess("Commission payment rejected.");
      setRejectId(null);
      setRejectReason("");
      load();
    } catch (err) {
      setError(errMsg(err, "Could not reject payment"));
    } finally {
      setBusyId(null);
    }
  }

  if (!payments) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-navy/5 p-4 text-xs text-slate">
        <p className="font-semibold text-navy">Merchant Commission Settle Verification (SRS Section 8)</p>
        <p>
          Merchants pay 5% commission on material sales to CampusHub's receiving account and submit evidence here.
          Verifying automatically settles the merchant's due commission records up to the verified amount.
        </p>
      </div>

      <ErrorBanner message={error} />
      <SuccessBanner message={success} />

      {payments.length === 0 ? (
        <p className="text-sm text-slate">No merchant commission payments submitted.</p>
      ) : (
        <div className="space-y-3">
          {payments.map((p) => (
            <Card key={p.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-navy">{p.merchant_name} <span className="text-xs text-slate">({p.merchant_email})</span></p>
                  <p className="text-xs text-slate">
                    Submitted: {new Date(p.created_at).toLocaleString()}
                  </p>
                  <p className="text-xs text-slate mt-0.5">
                    Ref: <span className="font-mono font-medium text-navy">{p.reference_number}</span>
                    {p.notes && <span className="ml-2">— {p.notes}</span>}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-bold text-accent-dark">{Number(p.amount).toFixed(2)} birr</p>
                  <Badge tone={p.status === "verified" ? "ok" : p.status === "rejected" ? "danger" : "warn"}>
                    {p.status}
                  </Badge>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 border-t border-slate/15 pt-3">
                <Button variant="outline" onClick={() => setOpenImgId(openImgId === p.id ? null : p.id)}>
                  {openImgId === p.id ? "Hide screenshot" : "View screenshot"}
                </Button>
                {p.status === "submitted" && (
                  <>
                    <Button variant="accent" disabled={busyId === p.id} onClick={() => verify(p.id)}>
                      Verify & Settle
                    </Button>
                    <Button variant="danger" disabled={busyId === p.id} onClick={() => setRejectId(rejectId === p.id ? null : p.id)}>
                      Reject
                    </Button>
                  </>
                )}
              </div>

              {openImgId === p.id && (
                <div className="mt-3">
                  <CommissionProofImage paymentId={p.id} />
                </div>
              )}

              {rejectId === p.id && (
                <div className="mt-3 space-y-2 rounded-lg bg-paper p-3">
                  <Input
                    label="Rejection Reason (required)"
                    placeholder="e.g. Reference not found in Telebirr statement"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button variant="danger" disabled={busyId === p.id || !rejectReason.trim()} onClick={() => reject(p.id)}>
                      Confirm Rejection
                    </Button>
                    <Button variant="ghost" onClick={() => setRejectId(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ReceivingAccountsTab() {
  const [accounts, setAccounts] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    method: "telebirr",
    accountName: "",
    accountNumber: "",
    instructions: "",
    isDefault: false,
  });

  async function load() {
    try {
      const { data } = await client.get("/admin/receiving-accounts");
      setAccounts(data.accounts || []);
    } catch (err) {
      setError(errMsg(err, "Could not load receiving accounts"));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd(e) {
    e.preventDefault();
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      await client.post("/admin/receiving-accounts", form);
      setSuccess("CampusHub receiving account added!");
      setForm({ method: "telebirr", accountName: "", accountNumber: "", instructions: "", isDefault: false });
      load();
    } catch (err) {
      setError(errMsg(err, "Could not add account"));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("Deactivate this CampusHub receiving account?")) return;
    setError("");
    setSuccess("");
    try {
      await client.delete(`/admin/receiving-accounts/${id}`);
      setSuccess("Account deactivated.");
      load();
    } catch (err) {
      setError(errMsg(err, "Could not delete account"));
    }
  }

  if (!accounts) return <Spinner />;

  return (
    <div className="space-y-6">
      <div className="rounded-lg bg-navy/5 p-4 text-xs text-slate">
        <p className="font-semibold text-navy">CampusHub University Receiving Accounts</p>
        <p>
          Configure the official Telebirr, CBE Birr, or Bank accounts that students and merchants transfer to
          for event ticket payments and platform commissions. Students pay these accounts directly.
        </p>
      </div>

      <ErrorBanner message={error} />
      <SuccessBanner message={success} />

      <Card className="p-5 border-navy/30 bg-paper max-w-xl">
        <h3 className="font-semibold text-navy mb-3">Add Official Receiving Account</h3>
        <form onSubmit={handleAdd} className="space-y-3">
          <Select
            label="Method"
            value={form.method}
            onChange={(e) => setForm({ ...form, method: e.target.value })}
          >
            <option value="telebirr">Telebirr</option>
            <option value="cbe_birr">CBE Birr</option>
            <option value="bank_transfer">Commercial Bank of Ethiopia (CBE)</option>
            <option value="other">Other Bank / Wallet</option>
          </Select>
          <Input
            label="Account Name (e.g. CampusHub Uni Branch)"
            required
            value={form.accountName}
            onChange={(e) => setForm({ ...form, accountName: e.target.value })}
          />
          <Input
            label="Account / Phone Number"
            required
            value={form.accountNumber}
            onChange={(e) => setForm({ ...form, accountNumber: e.target.value })}
          />
          <TextArea
            label="Instructions for payer (optional)"
            rows={2}
            placeholder="e.g. Put your student ID or order number in the payment reason"
            value={form.instructions}
            onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          />
          <label className="flex items-center gap-2 text-sm text-slate">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
            />
            Make this the primary default account for this campus
          </label>
          <Button type="submit" variant="accent" disabled={busy}>
            {busy ? "Saving..." : "Add Receiving Account"}
          </Button>
        </form>
      </Card>

      <div>
        <h3 className="font-semibold text-navy mb-3">Active Receiving Accounts ({accounts.length})</h3>
        {accounts.length === 0 ? (
          <p className="text-sm text-slate">No receiving accounts configured yet.</p>
        ) : (
          <div className="space-y-2">
            {accounts.map((a) => (
              <Card key={a.id} className="p-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-navy">{a.account_name}</p>
                    <Badge tone="navy">{a.method}</Badge>
                    {a.is_default && <Badge tone="ok">Default</Badge>}
                  </div>
                  <p className="font-mono text-sm text-slate mt-1">{a.account_number}</p>
                  {a.instructions && <p className="text-xs text-slate mt-0.5">{a.instructions}</p>}
                </div>
                <div>
                  <Button variant="danger" onClick={() => handleDelete(a.id)}>Deactivate</Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
