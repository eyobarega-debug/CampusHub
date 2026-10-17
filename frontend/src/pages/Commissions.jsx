import { useCallback, useEffect, useState } from "react";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import { Badge, Button, Card, EmptyState, ErrorBanner, Input, PageHeader, Spinner, SuccessBanner, TextArea } from "../components/ui";

const TYPE_LABEL = { order: "Shop sale", ticket: "Event ticket", booking: "Rental", p2p_order: "P2P sale" };
const STATUS_TONE = { due: "warn", settled: "ok", void: "slate" };
const STATUS_TEXT = { due: "due", settled: "paid", void: "cancelled (refund)" };
const FILTERS = [
  { id: "all", label: "All" },
  { id: "due", label: "Due" },
  { id: "settled", label: "Paid" },
];

const birr = (n) => `${Number(n).toFixed(2)} birr`;

export function SummaryCards({ summary }) {
  const items = [
    { label: "Sales", value: summary.salesCount },
    { label: "Total sold", value: birr(summary.grossSales) },
    { label: "Commission due", value: birr(summary.commissionDue), tone: "text-warn" },
    { label: "Commission paid", value: birr(summary.commissionSettled), tone: "text-ok" },
  ];
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((i) => (
        <Card key={i.label} className="p-4">
          <p className="text-xs text-slate">{i.label}</p>
          <p className={`text-xl font-bold ${i.tone || "text-navy"}`}>{i.value}</p>
        </Card>
      ))}
    </div>
  );
}

function SubmitCommissionModal({ defaultAmount, accounts, onDone, onCancel }) {
  const [amount, setAmount] = useState(defaultAmount > 0 ? String(defaultAmount) : "");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!file) {
      setError("Please attach a screenshot of your payment receipt");
      return;
    }
    if (!reference.trim() || reference.trim().length < 4) {
      setError("Please enter the transaction reference number");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("amount", amount);
      fd.append("referenceNumber", reference.trim());
      if (notes.trim()) fd.append("notes", notes.trim());
      fd.append("screenshot", file);

      await client.post("/commissions/submit-payment", fd);
      onDone("Payment proof submitted! CampusHub administration will verify and mark your commission as settled.");
    } catch (err) {
      setError(errMsg(err, "Failed to submit commission payment"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6 p-5 border-navy/30 bg-paper">
      <h3 className="font-semibold text-navy text-lg mb-2">Pay Commission to CampusHub</h3>
      <p className="text-xs text-slate mb-4">
        Transfer the commission amount to one of CampusHub's official receiving accounts below, then upload your transaction reference and screenshot.
      </p>

      {accounts && accounts.length > 0 && (
        <div className="mb-4 space-y-2">
          <p className="text-xs font-semibold text-navy uppercase tracking-wider">CampusHub Receiving Accounts</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {accounts.map((acc) => (
              <div key={acc.id} className="rounded-lg bg-white border border-slate/20 p-2.5 text-xs">
                <p className="font-semibold text-navy">{acc.account_name} ({acc.method})</p>
                <p className="font-mono text-slate font-medium text-sm">{acc.account_number}</p>
                {acc.instructions && <p className="text-slate text-[11px] mt-0.5">{acc.instructions}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <ErrorBanner message={error} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label="Amount (ETB)"
            type="number"
            step="0.01"
            min="1"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Input
            label="Transaction Reference Number"
            required
            placeholder="e.g. FT261017ABC..."
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-navy mb-1">Receipt Screenshot (Image)</label>
          <input
            type="file"
            accept="image/*"
            required
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="text-xs text-slate file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-navy file:text-white hover:file:bg-navy-dark"
          />
        </div>
        <TextArea
          label="Notes (optional)"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Any additional information..."
        />
        <div className="flex gap-2 pt-1">
          <Button type="submit" variant="accent" disabled={busy}>
            {busy ? "Submitting..." : "Submit Payment Proof"}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

// One row per sale. Shared by the seller page and the admin drill-in.
export function LedgerTable({ entries, action }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate">
          <tr>
            <th className="py-2 pr-3">Date</th>
            <th className="py-2 pr-3">Sale</th>
            <th className="py-2 pr-3 text-right">Amount</th>
            <th className="py-2 pr-3 text-right">Rate</th>
            <th className="py-2 pr-3 text-right">Commission</th>
            <th className="py-2 pr-3">Status</th>
            {action && <th className="py-2" />}
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-t border-slate/15 align-top">
              <td className="py-2 pr-3 text-xs text-slate">{new Date(e.createdAt).toLocaleDateString()}</td>
              <td className="py-2 pr-3">
                <p className="font-medium text-navy">{e.description || TYPE_LABEL[e.transactionType]}</p>
                <p className="text-xs text-slate">{TYPE_LABEL[e.transactionType] || e.transactionType}</p>
              </td>
              <td className="py-2 pr-3 text-right">
                {birr(e.saleAmount)}
                {e.baseAmount !== e.saleAmount && (
                  <p className="text-xs text-slate">charged on {birr(e.baseAmount)} (deposit excluded)</p>
                )}
              </td>
              <td className="py-2 pr-3 text-right">{(e.rate * 100).toFixed(0)}%</td>
              <td className="py-2 pr-3 text-right font-semibold text-navy">{birr(e.commission)}</td>
              <td className="py-2 pr-3">
                <Badge tone={STATUS_TONE[e.status]}>{STATUS_TEXT[e.status] || e.status}</Badge>
                {e.settleNote && <p className="mt-1 text-xs text-slate">{e.settleNote}</p>}
              </td>
              {action && <td className="py-2 text-right">{action(e)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Commissions() {
  const [filter, setFilter] = useState("all");
  const [data, setData] = useState(null);
  const [rates, setRates] = useState(null);
  const [submittedPayments, setSubmittedPayments] = useState([]);
  const [receivingAccounts, setReceivingAccounts] = useState([]);
  const [showPayModal, setShowPayModal] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const loadData = useCallback(async () => {
    setData(null);
    try {
      const res = await client.get(`/commissions/mine?status=${filter}`);
      setData(res.data);
    } catch (err) {
      setError(errMsg(err, "Could not load your commissions"));
    }
  }, [filter]);

  async function loadSubmissions() {
    try {
      const [pRes, aRes] = await Promise.all([
        client.get("/commissions/payments/mine"),
        client.get("/commissions/receiving-accounts"),
      ]);
      setSubmittedPayments(pRes.data.payments || []);
      setReceivingAccounts(aRes.data.accounts || []);
    } catch {
      // Ignore background fetch error
    }
  }

  useEffect(() => {
    client.get("/commissions/rates").then(({ data }) => setRates(data.rates)).catch(() => {});
    loadSubmissions();
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function handlePaymentSubmitted(msg) {
    setSuccess(msg);
    setShowPayModal(false);
    loadData();
    loadSubmissions();
  }

  const pct = (r) => `${Math.round(r * 100)}%`;

  return (
    <div>
      <PageHeader
        title="My commissions"
        subtitle={
          rates
            ? `CampusHub keeps ${pct(rates.order)} of shop sales, ${pct(rates.ticket)} of event tickets and ${pct(rates.booking)} of rental fees (deposit excluded).`
            : "The commission CampusHub keeps from each of your sales."
        }
        action={
          data?.summary?.commissionDue > 0 && !showPayModal ? (
            <Button variant="accent" onClick={() => { setShowPayModal(true); setSuccess(""); setError(""); }}>
              Pay Due Commission ({birr(data.summary.commissionDue)})
            </Button>
          ) : null
        }
      />
      <ErrorBanner message={error} />
      <SuccessBanner message={success} />

      {!data ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : (
        <>
          <SummaryCards summary={data.summary} />

          {showPayModal && (
            <SubmitCommissionModal
              defaultAmount={data.summary.commissionDue}
              accounts={receivingAccounts}
              onDone={handlePaymentSubmitted}
              onCancel={() => setShowPayModal(false)}
            />
          )}

          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-slate">
              You receive payments directly. The commission shown as <strong>due</strong> is what you pay to CampusHub.
            </p>
            {data.summary.commissionDue > 0 && !showPayModal && (
              <Button variant="accent" onClick={() => { setShowPayModal(true); setSuccess(""); setError(""); }}>
                Pay Commission
              </Button>
            )}
          </div>

          <div className="mb-3 flex gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${filter === f.id ? "bg-navy text-white" : "border border-slate/20 bg-white text-slate hover:bg-slate/10"}`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {data.entries.length === 0 ? (
            <EmptyState title="No commissions yet" subtitle="An entry appears here each time a payment you received is approved." />
          ) : (
            <Card className="p-4 mb-6"><LedgerTable entries={data.entries} /></Card>
          )}

          {submittedPayments.length > 0 && (
            <div className="mt-8">
              <h3 className="font-semibold text-navy mb-3">Submitted Commission Payments</h3>
              <div className="space-y-2">
                {submittedPayments.map((p) => (
                  <Card key={p.id} className="p-4 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-navy">{birr(p.amount)}</p>
                      <p className="text-xs text-slate">
                        Ref: <span className="font-mono">{p.reference_number}</span> · Submitted {new Date(p.created_at).toLocaleDateString()}
                      </p>
                      {p.reject_reason && <p className="text-xs text-danger mt-1">Rejection reason: {p.reject_reason}</p>}
                    </div>
                    <div>
                      <Badge tone={p.status === "verified" ? "ok" : p.status === "rejected" ? "danger" : "warn"}>
                        {p.status === "submitted" ? "Pending admin verification" : p.status}
                      </Badge>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}