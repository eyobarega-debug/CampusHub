import { useEffect, useState } from "react";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import { Badge, Card, EmptyState, ErrorBanner, PageHeader, Spinner } from "../components/ui";

export const TYPE_LABEL = { order: "Shop sale", ticket: "Event ticket", booking: "Rental", p2p_order: "P2P sale" };
const STATUS_TONE = { due: "warn", settled: "ok", void: "slate" };
const STATUS_TEXT = { due: "due", settled: "paid", void: "cancelled (refund)" };
const FILTERS = [
  { id: "all", label: "All" },
  { id: "due", label: "Due" },
  { id: "settled", label: "Paid" },
];

export const birr = (n) => `${Number(n).toFixed(2)} birr`;

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
  const [error, setError] = useState("");

  useEffect(() => {
    client.get("/commissions/rates").then(({ data }) => setRates(data.rates)).catch(() => {});
  }, []);

  useEffect(() => {
    setData(null);
    client
      .get(`/commissions/mine?status=${filter}`)
      .then(({ data }) => setData(data))
      .catch((err) => setError(errMsg(err, "Could not load your commissions")));
  }, [filter]);

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
      />
      <ErrorBanner message={error} />
      {!data ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : (
        <>
          <SummaryCards summary={data.summary} />
          <p className="mb-3 text-sm text-slate">
            You receive the full payment from the buyer. The commission shown as <strong>due</strong> is what you pay to CampusHub;
            the admin marks it as paid once you have.
          </p>
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
            <Card className="p-4"><LedgerTable entries={data.entries} /></Card>
          )}
        </>
      )}
    </div>
  );
}