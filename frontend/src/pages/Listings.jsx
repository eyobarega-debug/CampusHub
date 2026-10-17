import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Badge, Button, Card, EmptyState, Input, Select, Spinner } from "../components/ui";

export default function Listings() {
  const { user } = useAuth();
  const [listings, setListings] = useState(null);
  const [categories, setCategories] = useState([]);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");

  useEffect(() => {
    client.get("/meta/categories").then(({ data }) => setCategories(data.categories));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      client
        .get("/listings", { params: { q: q || undefined, category: category || undefined } })
        .then(({ data }) => setListings(data.listings));
    }, 250);
    return () => clearTimeout(t);
  }, [q, category]);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy">Student Marketplace (P2P)</h1>
          <p className="mt-1 text-sm text-slate">
            Items students are selling directly to other students.
            {user?.university_name && (
              <span className="block mt-0.5 text-xs font-medium text-accent-dark">
                📍 Viewing listings at {user.university_name}
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-36">
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
          <Input placeholder="Search listings..." className="w-56" value={q} onChange={(e) => setQ(e.target.value)} />
          {user?.role === "student" && <Button as={Link} to="/listings/new" variant="accent">+ Sell an item</Button>}
        </div>
      </div>

      {!listings ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : listings.length === 0 ? (
        <EmptyState title="No listings yet" subtitle="Be the first to list an item for sale." />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {listings.map((l) => (
            <Link key={l.id} to={`/listings/${l.id}`}>
              <Card className="h-full p-4 transition hover:shadow-md">
                <div className="mb-3 flex h-32 items-center justify-center rounded-lg bg-paper text-3xl">
                  {l.images?.[0] ? <img src={l.images[0]} alt="" className="h-full w-full rounded-lg object-cover" /> : "📦"}
                </div>
                <p className="font-medium text-navy line-clamp-1">{l.title}</p>
                <p className="text-xs text-slate">by {l.seller_name} · {l.condition || "—"}</p>
                <div className="mt-2 flex items-center justify-between">
                  <span className="font-semibold text-accent-dark">{Number(l.price).toFixed(2)} birr</span>
                  {l.status === "pending_review" && <Badge tone="warn">Under review</Badge>}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
