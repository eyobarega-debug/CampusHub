import { useEffect, useState } from "react";
import { client } from "../api/client";
import { useAuth, errMsg } from "../context/AuthContext";
import { Button, Card, ErrorBanner, TextArea } from "./ui";

export default function ReviewsPanel({ targetType, targetId, className = "" }) {
  const { user } = useAuth();
  const [reviews, setReviews] = useState([]);
  const [avgRating, setAvgRating] = useState(0);
  const [count, setCount] = useState(0);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const { data } = await client.get("/reviews", { params: { targetType, targetId } });
    setReviews(data.reviews);
    setAvgRating(data.avgRating);
    setCount(data.count);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetType, targetId]);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await client.post("/reviews", { targetType, targetId, rating, comment: comment || undefined });
      setComment("");
      await load();
    } catch (err) {
      setError(errMsg(err, "Could not submit review"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={className}>
      <h2 className="mb-3 text-lg font-semibold text-navy">
        Reviews {count > 0 && <span className="text-sm font-normal text-slate">· ⭐ {avgRating.toFixed(1)} ({count})</span>}
      </h2>

      {user?.role === "student" && (
        <Card className="mb-4 p-4">
          <ErrorBanner message={error} />
          <form onSubmit={submit} className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate">Rating:</span>
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  type="button"
                  key={n}
                  onClick={() => setRating(n)}
                  className={n <= rating ? "text-accent" : "text-slate/30"}
                >
                  ★
                </button>
              ))}
            </div>
            <TextArea placeholder="Optional comment..." rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
            <Button type="submit" disabled={busy}>{busy ? "Submitting..." : "Submit review"}</Button>
            <p className="text-xs text-slate">Only available after a completed transaction with this item (FR-047).</p>
          </form>
        </Card>
      )}

      {reviews.length === 0 ? (
        <p className="text-sm text-slate">No reviews yet.</p>
      ) : (
        <div className="space-y-3">
          {reviews.map((r) => (
            <Card key={r.id} className="p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-navy">{r.author_name}</span>
                <span className="text-accent">{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</span>
              </div>
              {r.comment && <p className="mt-1 text-sm text-slate">{r.comment}</p>}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
