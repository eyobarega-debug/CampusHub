import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import ImageUploader from "../components/ImageUploader";
import { Button, Card, ErrorBanner, Input, PageHeader, TextArea } from "../components/ui";

export default function RentalCreate() {
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);
  const inSixtyDays = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const [form, setForm] = useState({
    title: "",
    description: "",
    pricePerDay: "",
    deposit: "",
    availableFrom: today,
    availableTo: inSixtyDays,
    images: [],
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { data } = await client.post("/rentals", {
        title: form.title,
        description: form.description || undefined,
        pricePerDay: Number(form.pricePerDay),
        deposit: Number(form.deposit || 0),
        availableFrom: form.availableFrom,
        availableTo: form.availableTo,
        images: form.images,
      });
      navigate(`/rentals/${data.item.id}`);
    } catch (err) {
      setError(errMsg(err, "Could not list item"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="List an item for rent" subtitle="Books, calculators, projectors, sports gear — anything useful." />
      <Card className="p-6">
        <form onSubmit={submit} className="space-y-4">
          <ErrorBanner message={error} />
          <Input label="Title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <TextArea label="Description" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Price per day (birr)"
              type="number" min="0" required
              value={form.pricePerDay}
              onChange={(e) => setForm({ ...form, pricePerDay: e.target.value })}
            />
            <Input
              label="Refundable deposit"
              type="number" min="0"
              value={form.deposit}
              onChange={(e) => setForm({ ...form, deposit: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Available from" type="date" value={form.availableFrom} onChange={(e) => setForm({ ...form, availableFrom: e.target.value })} />
            <Input label="Available to" type="date" value={form.availableTo} onChange={(e) => setForm({ ...form, availableTo: e.target.value })} />
          </div>
          <div>
            <p className="mb-1 text-sm font-medium text-navy">Photos</p>
            <ImageUploader value={form.images} onChange={(images) => setForm({ ...form, images })} />
          </div>
          <Button type="submit" variant="accent" className="w-full" disabled={busy}>
            {busy ? "Publishing..." : "List item"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
