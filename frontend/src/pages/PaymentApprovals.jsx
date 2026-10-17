import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../api/client";
import { useAuth, errMsg } from "../context/AuthContext";
import { Badge, Button, Card, EmptyState, ErrorBanner, PageHeader, Spinner, SuccessBanner } from "../components/ui";
import ProofImage from "../components/ProofImage";

const TABS = [
  { id: "review", label: "To review", url: "/payments/manual/incoming?status=under_review" },
  { id: "awaiting", label: "Waiting for payment", url: "/payments/manual/incoming?status=pending" },
  { id: "history", label: "History", url: "/payments/manual/incoming?status=all", filter: (p) => ["confirmed", "failed", "refunded"].includes(p.status) },
  { id: "mine", label: "My payments", url: "/payments/manual/mine?status=all" },
];

const STATUS_TONE = { pending: "warn", under_review: "accent", confirmed: "ok", failed: "danger", refunded: "slate" };
const STATUS_TEXT = { pending: "waiting for proof", under_review: "to review", confirmed: "approved", failed: "cancelled", refunded: "refunded" };

function ReviewRow({ p, user, onDone, setError }) {
  const [showImg, setShowImg] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [cancelPayment, setCancelPayment] = useState(false);
  const [busy, setBusy] = useState(false);

  const isAdmin = ["admin", "super_admin"].includes(user?.role);
  const isTicket = p.transactionType === "ticket";

  async function act(path, body) {
    setError("");
    setBusy(true);
    try {
      await client.post(`/payments/${p.id}/${path}`, body || {});
      onDone(path === "approve" ? "Payment approved. The buyer has been notified." : "Payment rejected. The buyer has been notified.");
    } catch (err) {
      setError(errMsg(err, "Could not update this payment"));
    } finally {
      setBusy(false);
    }
  }

  if (isTicket && !isAdmin) {
    return (
      <div className="mt-3 border-t border-slate/15 pt-3">
        <div className="rounded-lg bg-navy/5 p-3 text-xs text-navy space-y-1">
          <p className="font-semibold">Event Ticket Payment — ግቢያችን Admin Approval Required</p>
          <p>
            Event ticket payments are received directly by ግቢያችን's designated admin account.
            Only authorized administrators can verify and approve ticket payments. Once verified, the attendee receives their active ticket and QR code, and 97.5% net revenue is allocated to your organizer payout balance.
          </p>
          <p className="font-mono text-slate">Reference: {p.proof?.referenceNumber || "None submitted"}</p>
        </div>
        <div className="mt-2 flex gap-2">
          <Button variant="outline" onClick={() => setShowImg((v) => !v)}>{showImg ? "Hide screenshot" : "View screenshot"}</Button>
        </div>
        {showImg && <div className="mt-3"><ProofImage paymentId={p.id} /></div>}
      </div>
    );
  }

  return (
    <div className="mt-3 border-t border-slate/15 pt-3">
     <p className="text-sm text-slate">
        Reference <span className="font-mono text-navy">{p.proof?.referenceNumber}</span>. Check that{" "}
        <strong>{p.amount.toFixed(2)} birr</strong> actually arrived in your account before approving.
        {isTicket && (
          <span className="block text-xs text-accent-dark font-medium mt-0.5">
            Admin verification: Approving issues the ticket QR code, retains 2.5% platform commission, and attributes 97.5% net payable to the event organizer.
          </span>
        )}
        {!isTicket && p.commissionRate != null && p.commissionRate > 0 && (
          <span className="block text-xs mt-0.5">
            Approving adds a {Math.round(p.commissionRate * 100)}% platform commission to your account
            {p.transactionType === "booking" ? " (on the rental fee, deposit excluded)" : ""}.
          </span>
        )}
        {!isTicket && p.commissionRate === 0 && (
          <span className="block text-xs text-ok mt-0.5">
            0% commission — 100% of the rental fee belongs to the lender.
          </span>
        )}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setShowImg((v) => !v)}>{showImg ? "Hide screenshot" : "View screenshot"}</Button>
        <Button variant="accent" disabled={busy} onClick={() => window.confirm(`Confirm you received ${p.amount.toFixed(2)} birr from ${p.payerName}?`) && act("approve")}>
          Approve
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => setRejecting((v) => !v)}>Reject</Button>
      </div>
      {showImg && <div className="mt-3"><ProofImage paymentId={p.id} /></div>}
      {rejecting && (
        <div className="mt-3 space-y-2 rounded-lg bg-paper p-3">
          <input
            className="w-full rounded-lg border border-slate/25 px-3 py-2 text-sm"
            placeholder="Reason, e.g. amount doesn't match"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm text-slate">
            <input type="checkbox" checked={cancelPayment} onChange={(e) => setCancelPayment(e.target.checked)} />
            Cancel the whole purchase (otherwise the buyer can upload a corrected proof)
          </label>
          <Button variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => act("reject", { reason: reason.trim(), cancelPayment })}>
            Send rejection
          </Button>
        </div>
      )}
    </div>
  );
}

export default function PaymentApprovals() {
  const { user } = useAuth();
  const [tab, setTab] = useState(user?.role === "student" ? "mine" : "review");
  const [items, setItems] = useState(null);
  const [counts, setCounts] = useState({});
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [needsAccount, setNeedsAccount] = useState(false);

  const current = TABS.find((t) => t.id === tab);

  const load = useCallback(async () => {
    try {
      const { data } = await client.get(current.url);
      setItems(current.filter ? data.payments.filter(current.filter) : data.payments);
    } catch (err) {
      setError(errMsg(err, "Could not load payments"));
    }
  }, [current]);

  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  useEffect(() => {
    client.get("/payments/manual/incoming?status=under_review").then(({ data }) => setCounts({ review: data.payments.length })).catch(() => {});
    if (user && ["merchant", "organizer"].includes(user.role)) {
      client.get("/payout-accounts").then(({ data }) => setNeedsAccount(data.accounts.length === 0)).catch(() => {});
    }
  }, [user, success]);

  function done(msg) {
    setSuccess(msg);
    load();
  }

  return (
    <div>
      <PageHeader
        title="Payments"
        subtitle="Students pay your account directly and upload a screenshot. You confirm it here."
        action={<Button as={Link} to="/payout-accounts" variant="outline">Payout accounts</Button>}
      />
      {needsAccount && (
        <div className="mb-4 rounded-lg bg-warn/10 px-4 py-3 text-sm text-warn">
          You haven't added a payout account yet, so students can't pay you directly.{" "}
          <Link to="/payout-accounts" className="font-medium underline">Add one</Link>
        </div>
      )}
      <ErrorBanner message={error} />
      <SuccessBanner message={success} />

      <div className="my-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => { setTab(t.id); setSuccess(""); setError(""); }}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${tab === t.id ? "bg-navy text-white" : "bg-white text-slate border border-slate/20 hover:bg-slate/10"}`}
          >
            {t.label}{t.id === "review" && counts.review ? ` (${counts.review})` : ""}
          </button>
        ))}
      </div>

      {!items ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : items.length === 0 ? (
        <EmptyState title="Nothing here" subtitle={tab === "review" ? "No payment proofs are waiting for you." : "No payments in this list."} />
      ) : (
        <div className="space-y-3">
          {items.map((p) => (
            <Card key={p.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-navy">{p.description || `${p.transactionType} payment`}</p>
                  <p className="text-xs text-slate">
                    {tab === "mine" ? `To ${p.payeeName}` : `From ${p.payerName}`} · {new Date(p.createdAt).toLocaleString()}
                  </p>
                  {p.proof?.status === "rejected" && p.status !== "under_review" && (
                    <p className="mt-1 text-xs text-danger">Rejected: {p.proof.rejectReason}</p>
                  )}
                </div>
                <div className="text-right">
                  <p className="font-semibold text-accent-dark">{p.amount.toFixed(2)} birr</p>
                  <Badge tone={STATUS_TONE[p.status]}>{STATUS_TEXT[p.status] || p.status}</Badge>
                </div>
              </div>
              {tab === "mine" && ["pending", "under_review"].includes(p.status) && (
                <div className="mt-3">
                  <Button as={Link} to={`/pay/manual/${p.id}`} variant="outline">
                    {p.status === "pending" ? "Upload proof" : "View status"}
                  </Button>
                </div>
              )}
              {tab !== "mine" && p.status === "under_review" && <ReviewRow p={p} user={user} onDone={done} setError={setError} />}
              {tab !== "mine" && p.status === "confirmed" && p.proof && (
                <p className="mt-2 text-xs text-slate">Reference <span className="font-mono">{p.proof.referenceNumber}</span></p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}