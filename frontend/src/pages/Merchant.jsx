import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import ImageUploader from "../components/ImageUploader";
import {
  Badge, Button, Card, ErrorBanner, Input, PageHeader, Select, Spinner, SuccessBanner, TextArea,
} from "../components/ui";

const TABS = ["Products", "Orders", "Store", "Analytics"];
const ORDER_STATUS_TONE = {
  pending_payment: "warn", confirmed: "navy", ready: "accent", completed: "ok",
  cancellation_requested: "warn", cancelled: "danger",
};

export default function Merchant() {
  const [store, setStore] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("Products");

  async function loadStore() {
    try {
      const { data } = await client.get("/merchants/stores/mine");
      setStore(data.store);
    } catch (err) {
      setError(errMsg(err, "Could not load your store"));
    }
  }
  useEffect(() => {
    loadStore();
  }, []);

  if (error) return <ErrorBanner message={error} />;
  if (!store) return <div className="flex justify-center py-16"><Spinner /></div>;

  return (
    <div>
      <PageHeader title={store.name} subtitle="Merchant dashboard — products, orders, and store settings." />
      <div className="mb-6 flex gap-1 border-b border-slate/15">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium ${tab === t ? "border-b-2 border-navy text-navy" : "text-slate hover:text-navy"}`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "Products" && <ProductsTab storeId={store.id} />}
      {tab === "Orders" && <OrdersTab />}
      {tab === "Store" && <StoreTab store={store} onSaved={setStore} />}
      {tab === "Analytics" && <AnalyticsTab storeId={store.id} />}
    </div>
  );
}

function ProductsTab({ storeId }) {
  const [products, setProducts] = useState(null);
  const [editing, setEditing] = useState(null); // product being edited, or {} for new
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function load() {
    const { data } = await client.get("/products", { params: { storeId } });
    setProducts(data.products);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  async function remove(id) {
    if (!confirm("Remove this product?")) return;
    await client.delete(`/products/${id}`);
    load();
  }

  async function promote(product) {
    const days = Number(prompt("Feature this product for how many days? (20 birr/day)", "7"));
    if (!days || days < 1) return;
    try {
      const { data } = await client.post(`/products/${product.id}/promote`, { days });
      navigate(`/mock-checkout/${data.payment.paymentId}`, {
        state: { amount: data.payment.amount, returnTo: "/merchant", label: `Feature "${product.title}" for ${days} day(s)` },
      });
    } catch (err) {
      setError(errMsg(err, "Could not start promotion"));
    }
  }

  return (
    <div>
      <ErrorBanner message={error} />
      <div className="mb-4 flex justify-end">
        <Button variant="accent" onClick={() => setEditing({})}>+ Add product</Button>
      </div>
      {editing && (
        <ProductForm
          product={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
          onError={(e) => setError(errMsg(e, "Could not save product"))}
        />
      )}
      {!products ? (
        <Spinner />
      ) : products.length === 0 ? (
        <p className="text-sm text-slate">No products yet — add your first one above.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <Card key={p.id} className="p-4">
              <div className="flex items-start justify-between">
                <p className="font-medium text-navy">{p.title}</p>
                <Badge tone={p.status === "active" ? "ok" : p.status === "out_of_stock" ? "warn" : "danger"}>{p.status}</Badge>
              </div>
              {p.featured_until && new Date(p.featured_until) > new Date() && (
                <Badge tone="accent">⭐ Featured until {new Date(p.featured_until).toLocaleDateString()}</Badge>
              )}
              <p className="mt-1 text-lg font-bold text-accent-dark">{Number(p.price).toFixed(2)} birr</p>
              <p className="text-xs text-slate">{p.stock} in stock</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setEditing(p)}>Edit</Button>
                <Button variant="outline" onClick={() => promote(p)}>⭐ Promote</Button>
                <Button variant="danger" onClick={() => remove(p.id)}>Remove</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ProductForm({ product, onCancel, onSaved, onError }) {
  const isNew = !product.id;
  const [form, setForm] = useState({
    title: product.title || "",
    description: product.description || "",
    price: product.price || "",
    stock: product.stock ?? "",
    images: product.images || [],
  });
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    const payload = { ...form, price: Number(form.price), stock: Number(form.stock) };
    try {
      if (isNew) await client.post("/products", payload);
      else await client.patch(`/products/${product.id}`, payload);
      onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mb-6 p-5">
      <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <Input label="Price (birr)" type="number" min="0" step="0.01" required value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
        <Input label="Stock" type="number" min="0" required value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} />
        <div className="sm:col-span-2">
          <TextArea label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div className="sm:col-span-2">
          <p className="mb-1 text-sm font-medium text-navy">Photos</p>
          <ImageUploader value={form.images} onChange={(images) => setForm({ ...form, images })} />
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" variant="accent" disabled={saving}>{saving ? "Saving..." : isNew ? "Create product" : "Save changes"}</Button>
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

const NEXT_STATUS = { confirmed: "ready", ready: "completed" };

function OrdersTab() {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState("");

  async function load() {
    const { data } = await client.get("/orders");
    setOrders(data.orders);
  }
  useEffect(() => {
    load();
  }, []);

  async function advance(order) {
    const next = NEXT_STATUS[order.status];
    if (!next) return;
    try {
      await client.patch(`/orders/${order.id}/status`, { status: next });
      load();
    } catch (err) {
      setError(errMsg(err, "Could not update order"));
    }
  }

  if (!orders) return <Spinner />;
  return (
    <div>
      <ErrorBanner message={error} />
      {orders.length === 0 ? (
        <p className="text-sm text-slate">No orders yet.</p>
      ) : (
        <div className="space-y-2">
          {orders.map((o) => (
            <Card key={o.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium text-navy">Order #{o.id.slice(0, 8)} — {o.buyer_name}</p>
                <p className="text-xs text-slate">{Number(o.total_amount).toFixed(2)} birr · {new Date(o.created_at).toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={ORDER_STATUS_TONE[o.status] || "slate"}>{o.status.replaceAll("_", " ")}</Badge>
                {NEXT_STATUS[o.status] && (
                  <Button variant="outline" onClick={() => advance(o)}>Mark {NEXT_STATUS[o.status]}</Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function StoreTab({ store, onSaved }) {
  const [form, setForm] = useState({ name: store.name, description: store.description || "" });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const { data } = await client.patch("/merchants/stores/mine", form);
      onSaved(data.store);
      setSuccess("Store updated.");
    } catch (err) {
      setError(errMsg(err, "Could not update store"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="max-w-lg p-5">
      <form onSubmit={submit} className="space-y-4">
        <ErrorBanner message={error} />
        <SuccessBanner message={success} />
        <Input label="Store name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <TextArea label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
      </form>
    </Card>
  );
}

function AnalyticsTab({ storeId }) {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    client.get(`/merchants/${storeId}/analytics`).then(({ data }) => setStats(data));
  }, [storeId]);

  async function downloadCsv() {
    const { data } = await client.get(`/merchants/${storeId}/orders/export`, { responseType: "blob" });
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = "orders.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!stats) return <Spinner />;
  return (
    <div>
      <div className="mb-4">
        <Button variant="outline" onClick={downloadCsv}>⬇ Export my orders CSV</Button>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card className="p-5">
          <p className="text-sm text-slate">Completed orders revenue</p>
          <p className="text-3xl font-bold text-accent-dark">{stats.revenue.toFixed(2)} birr</p>
          <p className="mt-1 text-xs text-slate">{stats.orderCount} total orders</p>
        </Card>
        <Card className="p-5">
          <p className="mb-2 text-sm font-medium text-navy">Top products</p>
          {stats.topProducts.length === 0 ? (
            <p className="text-sm text-slate">No sales yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {stats.topProducts.map((p) => (
                <li key={p.id} className="flex justify-between">
                  <span>{p.title}</span>
                  <span className="font-medium text-navy">{p.units_sold} sold</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
