import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { client } from "../api/client";
import { Badge, Button, Card, ErrorBanner, Input, PageHeader, SuccessBanner } from "../components/ui";
import QrScanner from "../components/QrScanner";

const RESULT_STYLE = {
  ADMIT: { tone: "ok", label: "✅ ADMIT" },
  ALREADY_USED: { tone: "danger", label: "⛔ ALREADY USED" },
  INVALID: { tone: "danger", label: "⛔ INVALID" },
};

export default function OrganizerEventDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [scanResult, setScanResult] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [queue, setQueue] = useState([]); // offline scan queue: {ticketId, qrToken, scannedAt}
  const [syncing, setSyncing] = useState(false);
  const [occCount, setOccCount] = useState(4);
  const [generating, setGenerating] = useState(false);

  async function load() {
    const { data } = await client.get(`/events/${id}/attendees`);
    setData(data);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Phase 2: offline scan queue & sync (SRS Phase 2 spec, item E). The QR
  // *signature* check happens purely client-side-adjacent (we still call
  // the API per scan when online), but when the browser reports itself
  // offline, scans are queued locally instead of attempted, and flushed as
  // one batch via POST /api/tickets/verify-batch once back online — see
  // that endpoint's comments for how it resolves scan order fairly.
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  async function handleScan(qrToken) {
    setError("");
    const ticketId = qrToken.split(".")[0];
    if (!ticketId) {
      setScanResult({ result: "INVALID", reason: "Unreadable QR content" });
      return;
    }

    if (!online) {
      setQueue((q) => [...q, { ticketId, qrToken, scannedAt: new Date().toISOString() }]);
      setScanResult({ result: "QUEUED", reason: "Offline — scan queued. Will verify once back online." });
      return;
    }

    try {
      const { data } = await client.post(`/tickets/${ticketId}/verify`, { qrToken });
      setScanResult(data);
      load();
    } catch (err) {
      setError(err?.response?.data?.error?.message || "Verification request failed");
    }
  }

  async function syncQueue() {
    if (queue.length === 0) return;
    setSyncing(true);
    setError("");
    try {
      const { data } = await client.post("/tickets/verify-batch", { scans: queue });
      const admitted = data.results.filter((r) => r.result === "ADMIT").length;
      const rejected = data.results.length - admitted;
      setSuccess(`Synced ${data.results.length} queued scans: ${admitted} admitted, ${rejected} rejected/duplicate.`);
      setQueue([]);
      load();
    } catch (err) {
      setError(err?.response?.data?.error?.message || "Batch sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function generateOccurrences() {
    setGenerating(true);
    setError("");
    setSuccess("");
    try {
      const { data } = await client.post(`/events/${id}/generate-occurrences`, { count: Number(occCount), intervalDays: 7 });
      setSuccess(`Generated ${data.occurrences.length} weekly occurrences, already published.`);
    } catch (err) {
      setError(err?.response?.data?.error?.message || "Could not generate occurrences");
    } finally {
      setGenerating(false);
    }
  }

  if (!data) return null;

  return (
    <div>
      <PageHeader title="Attendees & Check-in" subtitle="Live ticket sales and scan-time verification." />
      <ErrorBanner message={error} />
      <SuccessBanner message={success} />

      <div className={`mb-4 rounded-lg px-3 py-2 text-sm ${online ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"}`}>
        {online ? "🟢 Online — scans verify immediately" : "🟠 Offline — scans are being queued locally"}
        {queue.length > 0 && (
          <span className="ml-2">
            ({queue.length} queued)
            <Button variant="outline" className="ml-2" disabled={!online || syncing} onClick={syncQueue}>
              {syncing ? "Syncing..." : "Sync now"}
            </Button>
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-3 font-semibold text-navy">Scan a ticket</h2>
          <QrScanner onScan={handleScan} />
          {scanResult && (
            <div className={`mt-4 rounded-lg p-4 text-center ${scanResult.result === "ADMIT" ? "bg-ok/10" : scanResult.result === "QUEUED" ? "bg-warn/10" : "bg-danger/10"}`}>
              <p className={`text-lg font-bold ${scanResult.result === "ADMIT" ? "text-ok" : scanResult.result === "QUEUED" ? "text-warn" : "text-danger"}`}>
                {scanResult.result === "QUEUED" ? "🕓 QUEUED (offline)" : RESULT_STYLE[scanResult.result]?.label || scanResult.result}
              </p>
              {scanResult.ticket && (
                <p className="mt-1 text-sm text-slate">Ticket {scanResult.ticket.id?.slice(0, 8)}</p>
              )}
              {scanResult.reason && <p className="text-sm text-slate">{scanResult.reason}</p>}
              {scanResult.previousScanAt && (
                <p className="text-xs text-slate">Originally scanned {new Date(scanResult.previousScanAt).toLocaleString()}</p>
              )}
            </div>
          )}

          <details className="mt-4 text-xs text-slate">
            <summary className="cursor-pointer select-none">Simulate offline mode (for testing)</summary>
            <p className="mt-2">
              Your browser reports connectivity automatically. To test the offline queue without actually
              disconnecting, use your browser DevTools' Network tab → "Offline" throttling, then scan a
              few tickets and toggle back online to sync.
            </p>
          </details>
        </Card>

        <div>
          <Card className="mb-4 p-4">
            <h2 className="mb-2 font-semibold text-navy">Make this a recurring event</h2>
            <p className="mb-3 text-xs text-slate">
              Generates future weekly occurrences, already published (no re-approval needed for a series
              that's already been vetted once).
            </p>
            <div className="flex items-center gap-2">
              <Input type="number" min="1" max="12" value={occCount} onChange={(e) => setOccCount(e.target.value)} className="w-20" />
              <span className="text-sm text-slate">weekly occurrences</span>
              <Button variant="outline" disabled={generating} onClick={generateOccurrences}>
                {generating ? "Generating..." : "Generate"}
              </Button>
            </div>
          </Card>

          <h2 className="mb-3 font-semibold text-navy">Ticket sales</h2>
          <div className="mb-4 space-y-2">
            {data.sales.map((s) => (
              <div key={s.name} className="flex items-center justify-between rounded-lg bg-paper px-3 py-2 text-sm">
                <span>{s.name}</span>
                <span className="font-medium text-navy">{s.quantity_sold}/{s.quantity_total} sold</span>
              </div>
            ))}
          </div>

          <h2 className="mb-3 font-semibold text-navy">Attendees ({data.attendees.length})</h2>
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {data.attendees.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-lg border border-slate/15 px-3 py-2 text-sm">
                <div>
                  <p className="font-medium text-navy">{a.holder_name}</p>
                  <p className="text-xs text-slate">{a.ticket_type}</p>
                </div>
                <Badge tone={a.status === "used" ? "ok" : a.status === "cancelled" ? "danger" : "slate"}>{a.status}</Badge>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
