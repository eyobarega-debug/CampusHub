import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import { Badge, Button, Card, EmptyState, ErrorBanner, Input, PageHeader, Select, Spinner, SuccessBanner } from "../components/ui";
import { METHOD_LABEL } from "./ManualPayment";

export default function PayoutAccounts() {
  const [accounts, setAccounts] = useState(null);
  const [form, setForm] = useState({ method: "telebirr", accountName: "", accountNumber: "", instructions: "", isDefault: false });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const { data } = await client.get("/payout-accounts");
    setAccounts(data.accounts);
  }
  useEffect(() => {
    load().catch((err) => setError(errMsg(err, "Could not load your accounts")));
  }, []);

  async function add(e) {
    e.preventDefault();
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      await client.post("/payout-accounts", form);
      setForm({ ...form, accountName: "", accountNumber: "", instructions: "", isDefault: false });
      setSuccess("Account saved. Students will see it when they pay you.");
      await load();
    } catch (err) {
      setError(errMsg(err, "Could not save the account"));
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(id) {
    await client.patch(`/payout-accounts/${id}`, { isDefault: true });
    load();
  }
  async function remove(id) {
    if (!window.confirm("Remove this account? Payments already started keep the details they showed.")) return;
    await client.delete(`/payout-accounts/${id}`);
    load();
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Payout accounts"
        subtitle="Where students send money when they buy from you or pay for your event."
        action={<Button as={Link} to="/payment-approvals" variant="outline">Payments</Button>}
      />
      <ErrorBanner message={error} />
      <SuccessBanner message={success} />

      {!accounts ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : accounts.length === 0 ? (
        <EmptyState title="No accounts yet" subtitle="Add the bank or Telebirr account you want to be paid on." />
      ) : (
        <div className="space-y-3">
          {accounts.map((a) => (
            <Card key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate">{METHOD_LABEL[a.method] || a.method}</p>
                <p className="text-sm text-navy">{a.accountName}</p>
                <p className="font-mono text-navy">{a.accountNumber}</p>
                {a.instructions && <p className="mt-1 text-xs text-slate">Note for buyers: {a.instructions}</p>}
              </div>
              <div className="flex items-center gap-2">
                {a.isDefault ? <Badge tone="ok">Default</Badge> : <Button variant="outline" onClick={() => makeDefault(a.id)}>Make default</Button>}
                <Button variant="ghost" onClick={() => remove(a.id)}>Remove</Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card className="mt-6 p-6">
        <h2 className="mb-3 font-semibold text-navy">Add an account</h2>
        <form onSubmit={add} className="space-y-3">
          <Select label="Bank / wallet" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
            {Object.entries(METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Input label="Account holder name" value={form.accountName} onChange={(e) => setForm({ ...form, accountName: e.target.value })} required minLength={2} />
          <Input label="Account number / phone" value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} required minLength={4} />
          <Input
            label="Note for buyers (optional)"
            placeholder="e.g. Write your full name in the reference"
            maxLength={300}
            value={form.instructions}
            onChange={(e) => setForm({ ...form, instructions: e.target.value })}
          />
          <label className="flex items-center gap-2 text-sm text-slate">
            <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} />
            Show this one first
          </label>
          <Button type="submit" variant="accent" disabled={busy}>{busy ? "Saving..." : "Save account"}</Button>
        </form>
      </Card>
    </div>
  );
}