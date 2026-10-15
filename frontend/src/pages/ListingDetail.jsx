import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { client } from "../api/client";
import { useAuth, errMsg } from "../context/AuthContext";
import { Badge, Button, Card, ErrorBanner, PageHeader, Spinner, SuccessBanner, TextArea } from "../components/ui";

export default function ListingDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [listing, setListing] = useState(null);
  const [requests, setRequests] = useState(null);
  const [myRequest, setMyRequest] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const isOwner = user && listing && user.id === listing.seller_id;

  async function load() {
    const { data } = await client.get(`/listings/${id}`);
    setListing(data.listing);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (isOwner) client.get(`/listings/${id}/requests`).then(({ data }) => setRequests(data.requests));
    else if (user) client.get(`/listings/${id}/my-request`).then(({ data }) => setMyRequest(data));
  }, [isOwner, id, user]);

  async function sendRequest(e) {
    e.preventDefault();
    setError("");
    setSuccess("");
    try {
      await client.post(`/listings/${id}/requests`, { message: message || undefined });
      setSuccess("Request sent! The seller will reach out to arrange a handover.");
      setMessage("");
      const { data } = await client.get(`/listings/${id}/my-request`);
      setMyRequest(data);
    } catch (err) {
      setError(errMsg(err, "Could not send request"));
    }
  }

  async function decide(reqId, status) {
    await client.patch(`/listings/requests/${reqId}`, { status });
    const { data } = await client.get(`/listings/${id}/requests`);
    setRequests(data.requests);
  }

  async function markSold() {
    await client.patch(`/listings/${id}`, { status: "sold" });
    load();
  }

  async function payInApp() {
    setError("");
    try {
      const { data } = await client.post(`/listings/requests/${myRequest.request.id}/pay`, { paymentMethod: PAYMENT_METHOD });
      startCheckout(navigate, data.payment, { returnTo: `/listings/${id}`, label: `Pay for "${listing.title}"` });
    } catch (err) {
      setError(errMsg(err, "Could not start payment"));
    }
  }

  if (!listing) return <div className="flex justify-center py-16"><Spinner /></div>;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={listing.title}
        subtitle={`Sold by ${listing.seller_name} · ${listing.condition || "—"}`}
        action={<Badge tone={listing.status === "active" ? "ok" : "slate"}>{listing.status}</Badge>}
      />
      <Card className="p-6">
        <div className="mb-4 flex h-56 items-center justify-center rounded-lg bg-paper text-5xl">
          {listing.images?.[0] ? <img src={listing.images[0]} alt="" className="h-full w-full rounded-lg object-cover" /> : "📦"}
        </div>
        <p className="text-2xl font-bold text-accent-dark">{Number(listing.price).toFixed(2)} birr</p>
        <p className="mt-2 text-sm text-slate">{listing.description || "No description provided."}</p>

        {!isOwner && user?.role === "student" && listing.status === "active" && !myRequest?.request && (
          <form onSubmit={sendRequest} className="mt-6 space-y-2 border-t border-slate/15 pt-4">
            <ErrorBanner message={error} />
            <SuccessBanner message={success} />
            <TextArea label="Message to seller (optional)" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} />
            <Button type="submit" variant="accent">Request to buy</Button>
          </form>
        )}

        {!isOwner && myRequest?.request && (
          <div className="mt-6 border-t border-slate/15 pt-4">
            <ErrorBanner message={error} />
            <p className="mb-2 text-sm text-slate">
              Your request: <Badge tone={myRequest.request.status === "accepted" ? "ok" : myRequest.request.status === "declined" ? "danger" : "warn"}>{myRequest.request.status}</Badge>
            </p>
            {myRequest.order && myRequest.order.status === "pending_payment" && (
              <div>
                <p className="mb-2 text-sm text-slate">
                  The seller accepted — pay in-app now, or arrange an off-platform handover directly with them (Phase 1 default).
                </p>
                <Button variant="accent" onClick={payInApp}>Pay {Number(myRequest.order.amount).toFixed(2)} birr in-app</Button>
              </div>
            )}
            {myRequest.order?.status === "paid" && <Badge tone="ok">Paid — arrange pickup with the seller</Badge>}
          </div>
        )}

        {isOwner && (
          <div className="mt-6 border-t border-slate/15 pt-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="font-medium text-navy">Buy requests</p>
              {listing.status === "active" && <Button variant="outline" onClick={markSold}>Mark as sold</Button>}
            </div>
            {!requests ? (
              <Spinner />
            ) : requests.length === 0 ? (
              <p className="text-sm text-slate">No requests yet.</p>
            ) : (
              <div className="space-y-2">
                {requests.map((r) => (
                  <div key={r.id} className="flex items-center justify-between rounded-lg bg-paper p-3 text-sm">
                    <div>
                      <p className="font-medium text-navy">{r.buyer_name}</p>
                      {r.message && <p className="text-slate">{r.message}</p>}
                    </div>
                    {r.status === "pending" ? (
                      <div className="flex gap-2">
                        <Button variant="accent" onClick={() => decide(r.id, "accepted")}>Accept</Button>
                        <Button variant="outline" onClick={() => decide(r.id, "declined")}>Decline</Button>
                      </div>
                    ) : (
                      <Badge tone={r.status === "accepted" ? "ok" : "danger"}>{r.status}</Badge>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
