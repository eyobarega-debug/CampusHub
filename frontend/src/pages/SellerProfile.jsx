import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { client } from "../api/client";
import { useAuth, errMsg } from "../context/AuthContext";
import ImageUploader from "../components/ImageUploader";
import ReviewsPanel from "../components/ReviewsPanel";
import { Badge, Button, Card, ErrorBanner, Input, Spinner, SuccessBanner, TextArea } from "../components/ui";

const VERIFY_TONE = { verified: "ok", pending: "warn", unverified: "slate", suspended: "danger" };

function Stat({ label, value }) {
  return (
    <Card className="p-4 text-center">
      <p className="text-2xl font-bold text-navy">{value}</p>
      <p className="mt-1 text-xs text-slate">{label}</p>
    </Card>
  );
}

export default function SellerProfile() {
  const { id } = useParams();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");

  async function load() {
    setError("");
    try {
      const res = await client.get(`/sellers/${id}`);
      setData(res.data);
    } catch (err) {
      setError(errMsg(err, "Could not load this seller"));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function report() {
    const reason = prompt("Why are you reporting this seller?");
    if (!reason) return;
    try {
      await client.post("/reports", { targetType: "store", targetId: id, reason });
      setNotice("Thanks — your report was sent to the administrators.");
    } catch (err) {
      setError(errMsg(err, "Could not submit report"));
    }
  }

  if (error && !data) return <ErrorBanner message={error} />;
  if (!data) return <div className="flex justify-center py-16"><Spinner /></div>;

  const { seller, listings, listingsTotal, isOwner } = data;
  const v = seller.verification;

  return (
    <div className="mx-auto max-w-4xl">
      <ErrorBanner message={error} />
      <SuccessBanner message={notice} />

      <Card className="overflow-hidden">
        <div className="h-40 w-full bg-gradient-to-r from-navy to-accent">
          {seller.coverImageUrl && <img src={seller.coverImageUrl} alt="" className="h-full w-full object-cover" />}
        </div>
        <div className="relative px-6 pb-6">
          <div className="-mt-10 flex flex-wrap items-end justify-between gap-3">
            <div className="flex items-end gap-4">
              <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-xl border-4 border-white bg-paper text-3xl shadow">
                {seller.logoUrl ? <img src={seller.logoUrl} alt="" className="h-full w-full object-cover" /> : "🏬"}
              </div>
              <div className="pb-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-bold text-navy">{seller.name}</h1>
                  <Badge tone={VERIFY_TONE[v.status] || "slate"}>{v.label}</Badge>
                  {v.campusVerified && <Badge tone="ok">campus verified</Badge>}
                </div>
                <p className="mt-1 text-sm text-slate">
                  {seller.category && <span>{seller.category} · </span>}
                  {seller.university?.name && <span>{seller.university.name} · </span>}
                  Member since {new Date(seller.memberSince).toLocaleDateString()}
                </p>
              </div>
            </div>
            <div className="flex gap-2 pb-1">
              {isOwner && (
                <Button variant="outline" onClick={() => setEditing((e) => !e)}>{editing ? "Cancel" : "Edit profile"}</Button>
              )}
              {user && !isOwner && <Button variant="ghost" onClick={report}>Report seller</Button>}
            </div>
          </div>

          {seller.description && <p className="mt-4 whitespace-pre-line text-sm text-slate">{seller.description}</p>}

          {(seller.publicEmail || seller.publicPhone) && (
            <div className="mt-3 flex flex-wrap gap-4 text-sm">
              {seller.publicEmail && <a className="text-navy underline" href={`mailto:${seller.publicEmail}`}>{seller.publicEmail}</a>}
              {seller.publicPhone && <a className="text-navy underline" href={`tel:${seller.publicPhone}`}>{seller.publicPhone}</a>}
            </div>
          )}
        </div>
      </Card>

      {editing && isOwner && (
        <EditProfile seller={seller} onSaved={() => { setEditing(false); load(); }} onError={setError} />
      )}

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Active listings" value={seller.stats.activeListings} />
        <Stat label="Completed sales" value={seller.stats.completedSales} />
        <Stat label="Reviews" value={seller.stats.reviewCount} />
        <Stat label="Avg rating" value={seller.stats.reviewCount ? `⭐ ${seller.stats.avgRating.toFixed(1)}` : "—"} />
      </div>

      <div className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-navy">Active listings</h2>
          {listingsTotal > listings.length && (
            <Link to={`/marketplace?store=${seller.id}`} className="text-sm text-navy underline">
              View all {listingsTotal} listings →
            </Link>
          )}
        </div>
        {listings.length === 0 ? (
          <p className="text-sm text-slate">No active listings right now.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {listings.map((p) => (
              <Link key={p.id} to={`/marketplace/${p.id}`}>
                <Card className="h-full p-4 transition hover:shadow-md">
                  <div className="relative mb-3 flex h-32 items-center justify-center rounded-lg bg-paper text-3xl">
                    {p.images?.[0] ? <img src={p.images[0]} alt="" className="h-full w-full rounded-lg object-cover" /> : "🛍️"}
                    {p.is_featured && (
                      <span className="absolute left-2 top-2"><Badge tone="accent">⭐ Featured</Badge></span>
                    )}
                  </div>
                  <p className="font-medium text-navy line-clamp-1">{p.title}</p>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="font-semibold text-accent-dark">{Number(p.price).toFixed(2)} birr</span>
                    <Badge tone="ok">{p.stock} in stock</Badge>
                  </div>
                  {Number(p.review_count) > 0 && (
                    <p className="mt-1 text-xs text-slate">⭐ {Number(p.avg_rating).toFixed(1)} ({p.review_count})</p>
                  )}
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      <ReviewsPanel targetType="store" targetId={seller.id} className="mt-10" />
    </div>
  );
}

function EditProfile({ seller, onSaved, onError }) {
  const [form, setForm] = useState({
    name: seller.name || "",
    description: seller.description || "",
    category: seller.category || "",
    publicEmail: seller.publicEmail || "",
    publicPhone: seller.publicPhone || "",
  });
  const [cover, setCover] = useState(seller.coverImageUrl ? [seller.coverImageUrl] : []);
  const [logo, setLogo] = useState(seller.logoUrl ? [seller.logoUrl] : []);
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await client.patch("/merchants/stores/mine", {
        ...form,
        coverImageUrl: cover[0] || "",
        logoUrl: logo[0] || "",
      });
      onSaved();
    } catch (err) {
      onError(errMsg(err, "Could not save your profile"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mt-6 p-5">
      <h2 className="mb-3 text-lg font-semibold text-navy">Edit public profile</h2>
      <form onSubmit={submit} className="space-y-4">
        <Input label="Store name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <TextArea label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <Input label="Category" placeholder="e.g. Electronics, Food, Books" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input label="Public email" type="email" value={form.publicEmail} onChange={(e) => setForm({ ...form, publicEmail: e.target.value })} />
          <Input label="Public phone" value={form.publicPhone} onChange={(e) => setForm({ ...form, publicPhone: e.target.value })} />
        </div>
        <div>
          <p className="mb-1 text-sm font-medium text-navy">Cover image</p>
          <ImageUploader value={cover} onChange={setCover} max={1} />
        </div>
        <div>
          <p className="mb-1 text-sm font-medium text-navy">Logo</p>
          <ImageUploader value={logo} onChange={setLogo} max={1} />
        </div>
        <Button type="submit" variant="accent" disabled={saving}>{saving ? "Saving..." : "Save profile"}</Button>
      </form>
    </Card>
  );
}
