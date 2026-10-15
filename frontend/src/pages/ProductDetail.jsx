import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { client } from "../api/client";
import { useAuth, errMsg } from "../context/AuthContext";
import { Badge, Button, Card, ErrorBanner, PageHeader, Spinner } from "../components/ui";
import ReviewsPanel from "../components/ReviewsPanel";
import { PAYMENT_METHOD, startCheckout } from "../api/checkout";

export default function ProductDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [product, setProduct] = useState(null);
  const [qty, setQty] = useState(1);
  const [favorited, setFavorited] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    client.get(`/products/${id}`).then(({ data }) => setProduct(data.product));
  }, [id]);

  async function buyNow() {
    setError("");
    setBusy(true);
    try {
      const { data } = await client.post("/orders", { items: [{ productId: id, quantity: qty }], paymentMethod: PAYMENT_METHOD });
      startCheckout(navigate, data.payment, { returnTo: "/orders", label: `Order for ${product.title}` });
    } catch (err) {
      setError(errMsg(err, "Could not place order"));
    } finally {
      setBusy(false);
    }
  }

  async function favorite() {
    try {
      if (favorited) {
        await client.delete(`/products/${id}/favorite`);
        setFavorited(false);
      } else {
        await client.post(`/products/${id}/favorite`);
        setFavorited(true);
      }
    } catch {
      /* ignore */
    }
  }

  if (!product) return <div className="flex justify-center py-16"><Spinner /></div>;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={product.title} subtitle={`Sold by ${product.store_name}`} />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card className="flex h-72 items-center justify-center text-6xl">
          {product.images?.[0] ? (
            <img src={product.images[0]} alt="" className="h-full w-full rounded-xl object-cover" />
          ) : (
            "🛍️"
          )}
        </Card>
        <div>
          <ErrorBanner message={error} />
          <p className="text-3xl font-bold text-accent-dark">{Number(product.price).toFixed(2)} birr</p>
          <div className="mt-2">
            {product.status === "out_of_stock" ? <Badge tone="danger">Out of stock</Badge> : <Badge tone="ok">{product.stock} in stock</Badge>}
            {Number(product.review_count) > 0 && (
              <span className="ml-2 text-sm text-slate">⭐ {Number(product.avg_rating).toFixed(1)} ({product.review_count} reviews)</span>
            )}
          </div>
          <p className="mt-4 whitespace-pre-line text-sm text-slate">{product.description || "No description provided."}</p>

          {user?.role === "student" && (
            <div className="mt-6 flex items-center gap-3">
              <input
                type="number"
                min={1}
                max={product.stock}
                value={qty}
                onChange={(e) => setQty(Number(e.target.value))}
                className="w-20 rounded-lg border border-slate/25 px-3 py-2 text-sm"
              />
              <Button variant="accent" disabled={busy || product.status === "out_of_stock"} onClick={buyNow}>
                {busy ? "Placing order..." : "Buy now"}
              </Button>
              <Button variant="outline" onClick={favorite}>{favorited ? "♥ Saved" : "♡ Save"}</Button>
            </div>
          )}
          {!user && <p className="mt-6 text-sm text-slate">Log in as a student to purchase this product.</p>}
        </div>
      </div>

      <ReviewsPanel targetType="product" targetId={id} className="mt-10" />
    </div>
  );
}
