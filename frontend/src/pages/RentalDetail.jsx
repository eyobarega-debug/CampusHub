import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { client } from "../api/client";
import { useAuth, errMsg } from "../context/AuthContext";
import { Button, Card, EmptyState, ErrorBanner, Input, PageHeader, Spinner } from "../components/ui";
import { PAYMENT_METHOD, startCheckout } from "../api/checkout";

export default function RentalDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [dates, setDates] = useState({ startDate: "", endDate: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    client
      .get(`/rentals/${id}`)
      .then(({ data }) => {
        if (!cancelled) setItem(data.item);
      })
      .catch((err) => {
        if (!cancelled) {
          if (err?.response?.status === 404) {
            setLoadError("This item was not found or is not available at your campus.");
          } else {
            setLoadError(errMsg(err, "Could not load this rental item."));
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  const days =
    dates.startDate && dates.endDate
      ? Math.max(1, Math.ceil((new Date(dates.endDate) - new Date(dates.startDate)) / 86400000))
      : 0;
  const estTotal = item ? days * Number(item.price_per_day) + Number(item.deposit) : 0;

  async function book(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { data } = await client.post(`/rentals/${id}/bookings`, { ...dates, paymentMethod: PAYMENT_METHOD });
      startCheckout(navigate, data.payment, { returnTo: "/rentals/mine", label: `Rental: ${item.title}` });
    } catch (err) {
      setError(errMsg(err, "Could not book this item"));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>;
  if (loadError || !item) {
    return (
      <div className="mx-auto max-w-lg py-12 text-center">
        <EmptyState
          title="Rental Unavailable"
          subtitle={loadError || "This item was not found or is not available at your campus."}
          action={
            <Button as={Link} to="/rentals" variant="primary" className="mt-4">
              Back to Rentals
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={item.title} subtitle={`Owned by ${item.owner_name}`} />
      <Card className="p-6">
        <div className="mb-4 flex h-56 items-center justify-center rounded-lg bg-paper text-5xl">
          {item.images?.[0] ? <img src={item.images[0]} alt="" className="h-full w-full rounded-lg object-cover" /> : "🎒"}
        </div>
        <p className="text-sm text-slate">{item.description}</p>
        <div className="mt-3 flex gap-4 text-sm">
          <span className="font-semibold text-accent-dark">{Number(item.price_per_day).toFixed(2)} birr/day</span>
          <span className="text-slate">Refundable deposit: {Number(item.deposit).toFixed(2)} birr</span>
        </div>
        <p className="mt-1 text-xs text-slate">
          Available {item.available_from?.slice(0, 10)} to {item.available_to?.slice(0, 10)}
        </p>

        {user?.role === "student" && user.id !== item.owner_id && (
          <form onSubmit={book} className="mt-6 space-y-3 border-t border-slate/15 pt-4">
            <ErrorBanner message={error} />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Start date" type="date" required value={dates.startDate} onChange={(e) => setDates({ ...dates, startDate: e.target.value })} />
              <Input label="End date" type="date" required value={dates.endDate} onChange={(e) => setDates({ ...dates, endDate: e.target.value })} />
            </div>
            {days > 0 && (
              <p className="text-sm text-slate">
                {days} day(s) × {Number(item.price_per_day).toFixed(2)} + {Number(item.deposit).toFixed(2)} deposit ={" "}
                <span className="font-semibold text-navy">{estTotal.toFixed(2)} birr</span>
              </p>
            )}
            <Button type="submit" variant="accent" disabled={busy}>{busy ? "Booking..." : "Book this item"}</Button>
          </form>
        )}
      </Card>
    </div>
  );
}
