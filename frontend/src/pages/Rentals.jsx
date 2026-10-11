import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Button, Card, EmptyState, Input, Select, Spinner } from "../components/ui";

export default function Rentals() {
  const { user } = useAuth();
  const [items, setItems] = useState(null);
  const [categories, setCategories] = useState([]);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");

  useEffect(() => {
    client.get("/meta/categories").then(({ data }) => setCategories(data.categories));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      client
        .get("/rentals", { params: { q: q || undefined, category: category || undefined } })
        .then(({ data }) => setItems(data.items));
    }, 250);
    return () => clearTimeout(t);
  }, [q, category]);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy">Borrow &amp; Rent</h1>
          <p className="mt-1 text-sm text-slate">Books, calculators, projectors, and more — borrowed from fellow students.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-36">
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
          <Input placeholder="Search rentals..." className="w-56" value={q} onChange={(e) => setQ(e.target.value)} />
          {user?.role === "student" && <Button as={Link} to="/rentals/new" variant="accent">+ List an item</Button>}
          {user && <Button as={Link} to="/rentals/mine" variant="outline">My bookings</Button>}
        </div>
      </div>

      {!items ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : items.length === 0 ? (
        <EmptyState title="No rental items yet" />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((it) => (
            <Link key={it.id} to={`/rentals/${it.id}`}>
              <Card className="h-full p-4 transition hover:shadow-md">
                <div className="mb-3 flex h-32 items-center justify-center rounded-lg bg-paper text-3xl">
                  {it.images?.[0] ? <img src={it.images[0]} alt="" className="h-full w-full rounded-lg object-cover" /> : "🎒"}
                </div>
                <p className="font-medium text-navy line-clamp-1">{it.title}</p>
                <p className="text-xs text-slate">by {it.owner_name}</p>
                <div className="mt-2 flex items-center justify-between text-sm">
                  <span className="font-semibold text-accent-dark">{Number(it.price_per_day).toFixed(2)} birr/day</span>
                  <span className="text-slate">deposit {Number(it.deposit).toFixed(0)}</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
