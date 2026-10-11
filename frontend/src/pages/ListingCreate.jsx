import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import ImageUploader from "../components/ImageUploader";
import { Button, Card, ErrorBanner, Input, PageHeader, Select, TextArea } from "../components/ui";

export default function ListingCreate() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ title: "", description: "", price: "", condition: "Good", images: [] });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { data } = await client.post("/listings", {
        title: form.title,
        description: form.description || undefined,
        price: Number(form.price),
        condition: form.condition,
        images: form.images,
      });
      navigate(`/listings/${data.listing.id}`);
    } catch (err) {
      setError(errMsg(err, "Could not create listing"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="Sell an item" subtitle="List something for other students to buy directly from you." />
      <Card className="p-6">
        <form onSubmit={submit} className="space-y-4">
          <ErrorBanner message={error} />
          <Input label="Title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <TextArea label="Description" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <Input
            label="Price (birr)"
            type="number"
            min="0"
            required
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
          />
          <Select label="Condition" value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })}>
            {["New", "Like New", "Good", "Fair", "Worn"].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
          <div>
            <p className="mb-1 text-sm font-medium text-navy">Photos</p>
            <ImageUploader value={form.images} onChange={(images) => setForm({ ...form, images })} />
          </div>
          <Button type="submit" variant="accent" className="w-full" disabled={busy}>
            {busy ? "Publishing..." : "Publish listing"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
