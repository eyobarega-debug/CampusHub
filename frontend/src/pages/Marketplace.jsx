import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { client } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Badge, Card, EmptyState, Input, Select, Spinner } from "../components/ui";

export default function Marketplace() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const storeId = searchParams.get("store") || "";
  const [products, setProducts] = useState(null);
  const [categories, setCategories] = useState([]);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");

  useEffect(() => {
    client.get("/meta/categories").then(({ data }) => setCategories(data.categories));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      client
        .get("/products", { params: { q: q || undefined, category: category || undefined, storeId: storeId || undefined } })
        .then(({ data }) => setProducts(data.products));
    }, 250);
    return () => clearTimeout(t);
  }, [q, category, storeId]);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy">Marketplace</h1>
          <p className="mt-1 text-sm text-slate">
            Browse products and services from verified campus merchants.
            {user?.university_name && (
              <span className="block mt-0.5 text-xs font-medium text-accent-dark">
                📍 Viewing items at {user.university_name}
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-40">
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
          <Input placeholder="Search products..." className="w-64" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {storeId && (
        <div className="mb-4 flex items-center justify-between rounded-lg bg-navy/5 px-4 py-2 text-sm text-navy">
          <span>Showing products from a single seller.</span>
          <Link to="/marketplace" className="underline">Clear filter</Link>
        </div>
      )}

      {!products ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : products.length === 0 ? (
        <EmptyState title="No products found" subtitle="Try a different search term or category." />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <Link key={p.id} to={`/marketplace/${p.id}`}>
              <Card className="h-full p-4 transition hover:shadow-md">
                <div className="relative mb-3 flex h-32 items-center justify-center rounded-lg bg-paper text-3xl">
                  {p.images?.[0] ? <img src={p.images[0]} alt="" className="h-full w-full rounded-lg object-cover" /> : "🛍️"}
                  {p.is_featured && (
                    <span className="absolute left-2 top-2">
                      <Badge tone="accent">⭐ Featured</Badge>
                    </span>
                  )}
                </div>
                <p className="font-medium text-navy line-clamp-1">{p.title}</p>
                <p className="text-xs text-slate">
                  <span
                    role="link"
                    tabIndex={0}
                    className="hover:text-navy hover:underline"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate(`/seller/${p.store_id}`); }}
                  >
                    {p.store_name}
                  </span>
                </p>
                <div className="mt-2 flex items-center justify-between">
                  <span className="font-semibold text-accent-dark">{Number(p.price).toFixed(2)} birr</span>
                  {p.status === "out_of_stock" ? (
                    <Badge tone="danger">Out of stock</Badge>
                  ) : (
                    <Badge tone="ok">{p.stock} in stock</Badge>
                  )}
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
  );
}
