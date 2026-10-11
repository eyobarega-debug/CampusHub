import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../api/client";
import { Button, Card, EmptyState, PageHeader, Spinner } from "../components/ui";

export default function Favorites() {
  const [products, setProducts] = useState(null);

  async function load() {
    const { data } = await client.get("/products/me/favorites");
    setProducts(data.products);
  }
  useEffect(() => {
    load();
  }, []);

  async function unfavorite(id) {
    await client.delete(`/products/${id}/favorite`);
    load();
  }

  if (!products) return <div className="flex justify-center py-16"><Spinner /></div>;

  return (
    <div>
      <PageHeader title="My Favorites" subtitle="Products you've saved for later (FR-010)." />
      {products.length === 0 ? (
        <EmptyState
          title="No favorites yet"
          subtitle="Tap the save icon on any product to add it here."
          action={<Button as={Link} to="/marketplace" className="mt-3">Browse the marketplace</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <Card key={p.id} className="p-4">
              <Link to={`/marketplace/${p.id}`} className="font-medium text-navy hover:underline">{p.title}</Link>
              <p className="mt-1 text-lg font-bold text-accent-dark">{Number(p.price).toFixed(2)} birr</p>
              <p className="text-xs text-slate">{p.status === "active" ? `${p.stock} in stock` : p.status.replaceAll("_", " ")}</p>
              <Button variant="outline" className="mt-3 w-full" onClick={() => unfavorite(p.id)}>Remove from favorites</Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
