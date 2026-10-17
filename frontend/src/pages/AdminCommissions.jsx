import { useCallback, useEffect, useState } from "react";
import { client } from "../api/client";
import { useAuth, errMsg } from "../context/AuthContext";
import { Badge, Button, Card, EmptyState, ErrorBanner, PageHeader, Spinner, SuccessBanner } from "../components/ui";
import { LedgerTable, SummaryCards, birr } from "./Commissions";

const ROLE_LABEL = { merchant: "Merchant", organizer: "Event organizer", student: "Student (rentals / P2P)" };

// The admin's ledger for ONE seller: their own sales, what they owe, and the settle buttons.
function SellerLedger({ seller, onChanged, setError, setSuccess }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await client.get(`/commissions/admin/sellers/${seller.userId}`);
      setData(res.data);
    } catch (err) {
      setError(errMsg(err, "Could not load this seller's ledger"));
    }
  }, [seller.userId, setError]);

  useEffect(() => {
    load();
  }, [load]);

  async function settle(path, msg) {
    const note = window.prompt("Note (optional), e.g. how the seller paid:", "");
    if (note === null) return;
    setBusy(true);
    setError("");
    try {
      const { data: r } = await client.post(path, { note: note.trim() || undefined });
      setSuccess(`${msg} ${birr(r.total)} marked as paid.`);
      await load();
      onChanged();
    } catch (err) {
      setError(errMsg(err, "Could not mark as paid"));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div className="flex justify-center py-6"><Spinner /></div>;
  return (
    <div className="mt-4 border-t border-slate/15 pt-4">
      <SummaryCards summary={data.summary} />
      {data.summary.commissionDue > 0 && (
        <Button
          variant="accent"
          className="mb-3"
          disabled={busy}
          onClick={() => settle(`/commissions/admin/sellers/${seller.userId}/settle`, `${seller.name}:`)}
        >
          Mark all due ({birr(data.summary.commissionDue)}) as paid
        </Button>
      )}
      <LedgerTable
        entries={data.entries}
        action={(e) =>
          e.status === "due" && (
            <Button variant="outline" disabled={busy} onClick={() => settle(`/commissions/admin/${e.id}/settle`, "Entry:")}>
              Mark paid
            </Button>
          )
        }
      />
    </div>
  );
}

export default function AdminCommissions() {
  const { user } = useAuth();
  const [sellers, setSellers] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = useCallback(async () => {
    try {
      const { data } = await client.get("/commissions/admin/sellers");
      setSellers(data.sellers);
    } catch (err) {
      setError(errMsg(err, "Could not load commissions"));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const totalDue = (sellers || []).reduce((t, s) => t + s.commissionDue, 0);

  const subtitle = user?.university_name
    ? `Managing seller commissions for ${user.university_name} — Open one to see their sales and mark commission as paid.`
    : "Every merchant, event organizer and renting student has their own account. Open one to see their sales and mark commission as paid.";

  return (
    <div>
      <PageHeader
        title="Seller commissions"
        subtitle={subtitle}
      />
      <ErrorBanner message={error} />
      <SuccessBanner message={success} />
      {!sellers ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : sellers.length === 0 ? (
        <EmptyState title="No commissions yet" subtitle="Entries appear when a seller approves a payment." />
      ) : (
        <>
          <p className="mb-3 text-sm text-slate">
            {sellers.length} seller{sellers.length === 1 ? "" : "s"} · {birr(totalDue)} due across all of them
          </p>
          <div className="space-y-3">
            {sellers.map((s) => (
              <Card key={s.userId} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-navy">{s.name}</p>
                    <p className="text-xs text-slate">{s.email}</p>
                    <div className="mt-1"><Badge tone="navy">{ROLE_LABEL[s.role] || s.role}</Badge></div>
                  </div>
                  <div className="text-right text-sm">
                    <p className="text-slate">{s.salesCount} sale{s.salesCount === 1 ? "" : "s"} · {birr(s.grossSales)}</p>
                    <p className="font-semibold text-warn">Due {birr(s.commissionDue)}</p>
                    <p className="text-ok">Paid {birr(s.commissionSettled)}</p>
                  </div>
                </div>
                <p className="mt-2 text-xs text-slate">
                  Commission by type: shop {birr(s.byType.shop)} · tickets {birr(s.byType.tickets)} · rentals {birr(s.byType.rentals)}
                  {s.byType.other > 0 ? ` · other ${birr(s.byType.other)}` : ""}
                </p>
                <div className="mt-3">
                  <Button variant="outline" onClick={() => setOpen(open === s.userId ? null : s.userId)}>
                    {open === s.userId ? "Hide ledger" : "View ledger"}
                  </Button>
                </div>
                {open === s.userId && <SellerLedger seller={s} onChanged={load} setError={setError} setSuccess={setSuccess} />}
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}