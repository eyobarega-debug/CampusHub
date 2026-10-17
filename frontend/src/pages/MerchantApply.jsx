import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import { Button, Card, ErrorBanner, Input, PageHeader, SuccessBanner, TextArea } from "../components/ui";

export default function MerchantApply() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ businessName: "", category: "", contactInfo: "" });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await client.post("/merchants/apply", form);
      setSuccess("Application submitted! A university administrator will review it (FR-039).");
      setTimeout(() => navigate("/"), 2000);
    } catch (err) {
      setError(errMsg(err, "Could not submit application"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-md py-8">
      <PageHeader title="Apply to sell on ግቢያችን" subtitle="Once approved, you'll get a store dashboard to add products and manage orders." />
      <Card className="p-6">
        <form onSubmit={onSubmit} className="space-y-4">
          <ErrorBanner message={error} />
          <SuccessBanner message={success} />
          <Input
            label="Business name"
            required
            value={form.businessName}
            onChange={(e) => setForm({ ...form, businessName: e.target.value })}
          />
          <Input label="Category" placeholder="e.g. Stationery, Food, Printing" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          <TextArea label="Contact info" placeholder="Phone / Telegram / location on campus" value={form.contactInfo} onChange={(e) => setForm({ ...form, contactInfo: e.target.value })} />
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Submitting..." : "Submit application"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
