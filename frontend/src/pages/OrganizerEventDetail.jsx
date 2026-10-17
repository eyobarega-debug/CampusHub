import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { client } from "../api/client";
import { Badge, Button, Card, ErrorBanner, Input, PageHeader, SuccessBanner } from "../components/ui";
import QrScanner from "../components/QrScanner";

const RESULT_STYLE = {
  ADMIT: { tone: "ok", label: "✅ ADMITTED — ENTRY GRANTED" },
  VALID: { tone: "ok", label: "🟢 VALID TICKET — READY FOR ENTRY" },
  ALREADY_USED: { tone: "danger", label: "⛔ ENTRY DENIED — TICKET ALREADY USED" },
  PAYMENT_NOT_APPROVED: { tone: "warn", label: "⚠️ ENTRY DENIED — PAYMENT NOT VERIFIED" },
  CANCELLED: { tone: "danger", label: "⛔ ENTRY DENIED — TICKET CANCELLED" },
  EVENT_CANCELLED: { tone: "danger", label: "⛔ ENTRY DENIED — EVENT CANCELLED" },
  INVALID: { tone: "danger", label: "⛔ ENTRY DENIED — INVALID TICKET" },
  FORBIDDEN_CROSS_CAMPUS: { tone: "danger", label: "⛔ CROSS-CAMPUS TICKET NOT ADMITTED" },
};

export default function OrganizerEventDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [checkins, setCheckins] = useState([]);
  const [scanResult, setScanResult] = useState(null);
  const [autoCheckIn, setAutoCheckIn] = useState(true);
  const [currentQrToken, setCurrentQrToken] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [queue, setQueue] = useState([]); // offline scan queue
  const [syncing, setSyncing] = useState(false);
  const [occCount, setOccCount] = useState(4);
  const [generating, setGenerating] = useState(false);
  const [reversingId, setReversingId] = useState(null);

  async function load() {
    try {
      const [attRes, chkRes] = await Promise.all([
        client.get(`/events/${id}/attendees`),
        client.get(`/tickets/event/${id}/checkins`).catch(() => ({ data: { checkins: [] } })),
      ]);
      setData(attRes.data);
      setCheckins(chkRes.data.checkins || []);
    } catch (err) {
      setError(err?.response?.data?.error?.message || "Failed to load event data");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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

  // Parse QR token from scanned string (URL or raw token)
  function extractQrToken(raw) {
    if (!raw) return "";
    const clean = raw.trim();
    if (clean.includes("/tickets/verify/")) {
      const parts = clean.split("/tickets/verify/");
      return parts[parts.length - 1].split("?")[0].trim();
    }
    return clean;
  }

  async function handleScan(scannedPayload) {
    setError("");
    setSuccess("");
    const token = extractQrToken(scannedPayload);
    setCurrentQrToken(token);

    const ticketId = token.split(".")[0];
    if (!ticketId) {
      setScanResult({ result: "INVALID", reason: "Unreadable QR content" });
      return;
    }

    if (!online) {
      setQueue((q) => [...q, { ticketId, qrToken: token, scannedAt: new Date().toISOString() }]);
      setScanResult({ result: "QUEUED", reason: "Offline — scan queued. Will verify once back online." });
      return;
    }

    try {
      if (autoCheckIn) {
        // Direct atomic admission
        const { data: res } = await client.post("/tickets/scan", {
          qrToken: token,
          action: "check_in",
          deviceInfo: navigator.userAgent?.slice(0, 50),
        });
        setScanResult(res);
        if (res.result === "ADMIT") {
          setSuccess(`Admitted: ${res.ticket?.holder_name || "Attendee"}`);
        }
      } else {
        // Inspection mode: show details first, require explicit staff admission click
        const { data: res } = await client.post("/tickets/scan", {
          qrToken: token,
          action: "inspect",
        });
        setScanResult(res);
      }
      await load();
    } catch (err) {
      const code = err?.response?.data?.error?.code;
      const msg = err?.response?.data?.error?.message;
      if (code === "FORBIDDEN_CROSS_CAMPUS" || (err?.response?.status === 403 && msg?.toLowerCase().includes("another university"))) {
        const crossCampusMsg = "This ticket belongs to another university and cannot be verified here.";
        setError(crossCampusMsg);
        setScanResult({ result: "FORBIDDEN_CROSS_CAMPUS", reason: crossCampusMsg });
      } else {
        setError(msg || "Verification request failed");
        setScanResult({ result: "INVALID", reason: msg || "Scan failed" });
      }
    }
  }

  // Explicit admit action when in inspection mode
  async function admitInspected() {
    if (!scanResult?.ticket?.id && !currentQrToken) return;
    setError("");
    setSuccess("");
    try {
      const { data: res } = await client.post("/tickets/scan", {
        qrToken: currentQrToken,
        action: "check_in",
      });
      setScanResult(res);
      if (res.result === "ADMIT") {
        setSuccess(`Admitted: ${res.ticket?.holder_name || "Attendee"}`);
      }
      await load();
    } catch (err) {
      setError(err?.response?.data?.error?.message || "Could not check in attendee");
    }
  }

  // Authorized check-in reversal
  async function reverseCheckIn(ticketId) {
    const reason = window.prompt("Reason for check-in reversal:", "Accidental scan / Entry reset");
    if (!reason) return;
    setReversingId(ticketId);
    setError("");
    setSuccess("");
    try {
      await client.post(`/tickets/${ticketId}/reverse-checkin`, { reason });
      setSuccess("Check-in successfully reversed. Ticket restored to active.");
      if (scanResult?.ticket?.id === ticketId) {
        setScanResult(null);
      }
      await load();
    } catch (err) {
      setError(err?.response?.data?.error?.message || "Failed to reverse check-in");
    } finally {
      setReversingId(null);
    }
  }

  async function syncQueue() {
    if (queue.length === 0) return;
    setSyncing(true);
    setError("");
    try {
      const { data: res } = await client.post("/tickets/verify-batch", { scans: queue });
      const admitted = res.results.filter((r) => r.result === "ADMIT").length;
      const rejected = res.results.length - admitted;
      setSuccess(`Synced ${res.results.length} queued scans: ${admitted} admitted, ${rejected} rejected/duplicate.`);
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
      const { data: res } = await client.post(`/events/${id}/generate-occurrences`, { count: Number(occCount), intervalDays: 7 });
      setSuccess(`Generated ${res.occurrences.length} weekly occurrences, already published.`);
    } catch (err) {
      setError(err?.response?.data?.error?.message || "Could not generate occurrences");
    } finally {
      setGenerating(false);
    }
  }

  if (!data) return null;

  return (
    <div>
      <PageHeader
        title="Event Check-In & Scanner Station"
        subtitle="Live gate verification, atomic check-ins, attendee lookup, and audit trail."
      />

      <ErrorBanner message={error} />
      <SuccessBanner message={success} />

      {/* Connectivity & Offline Status Bar */}
      <div className={`mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg px-3.5 py-2.5 text-sm ${
        online ? "bg-ok/10 text-ok border border-ok/20" : "bg-warn/10 text-warn border border-warn/20"
      }`}>
        <div className="flex items-center gap-2">
          <span>{online ? "🟢 Online Mode" : "🟠 Offline Queue Mode"}</span>
          <span className="text-xs text-slate">· Gibiyachin Gate Auth</span>
        </div>
        {queue.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold">({queue.length} scans queued offline)</span>
            <Button variant="outline" className="text-xs" disabled={!online || syncing} onClick={syncQueue}>
              {syncing ? "Syncing..." : "Sync Scans Now"}
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Scanner Panel */}
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between border-b border-slate/15 pb-2">
            <h2 className="font-bold text-navy">Entrance Scanner</h2>
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate">
              <input
                type="checkbox"
                checked={autoCheckIn}
                onChange={(e) => setAutoCheckIn(e.target.checked)}
                className="rounded text-navy focus:ring-navy"
              />
              <span>Auto-Admit on scan</span>
            </label>
          </div>

          <QrScanner onScan={handleScan} />

          {/* Verification Result Card */}
          {scanResult && (
            <div
              className={`mt-4 rounded-xl border p-4 text-center transition ${
                scanResult.result === "ADMIT" || scanResult.result === "VALID"
                  ? "border-ok/30 bg-ok/10"
                  : scanResult.result === "QUEUED"
                  ? "border-warn/30 bg-warn/10"
                  : scanResult.result === "PAYMENT_NOT_APPROVED"
                  ? "border-warn/40 bg-warn/10"
                  : "border-danger/30 bg-danger/10"
              }`}
            >
              <p
                className={`text-base font-extrabold tracking-wide ${
                  scanResult.result === "ADMIT" || scanResult.result === "VALID"
                    ? "text-ok"
                    : scanResult.result === "QUEUED" || scanResult.result === "PAYMENT_NOT_APPROVED"
                    ? "text-warn"
                    : "text-danger"
                }`}
              >
                {RESULT_STYLE[scanResult.result]?.label || scanResult.result}
              </p>

              {/* Attendee & Ticket Info */}
              {(scanResult.ticket || scanResult.attendeeName) && (
                <div className="mt-3 rounded-lg bg-white/80 p-3 text-left shadow-xs">
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-slate uppercase text-[10px] font-semibold">Attendee</span>
                      <p className="font-bold text-navy">
                        {scanResult.attendeeName || scanResult.ticket?.holder_name || "Unknown"}
                      </p>
                    </div>
                    <div>
                      <span className="text-slate uppercase text-[10px] font-semibold">Ticket Tier</span>
                      <p className="font-medium text-navy">
                        {scanResult.ticketType || scanResult.ticket?.ticket_type || "General"}
                      </p>
                    </div>
                    <div>
                      <span className="text-slate uppercase text-[10px] font-semibold">Ticket #</span>
                      <p className="font-mono font-bold text-navy">
                        {scanResult.ticketNumber || scanResult.ticket?.ticket_number || scanResult.ticket?.id?.slice(0, 8)}
                      </p>
                    </div>
                    <div>
                      <span className="text-slate uppercase text-[10px] font-semibold">Status</span>
                      <p className="font-semibold text-navy capitalize">
                        {scanResult.ticket?.status || scanResult.result}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {scanResult.reason && (
                <p className="mt-2 text-xs font-medium text-slate">{scanResult.reason}</p>
              )}

              {/* Previous check-in details if ALREADY USED */}
              {scanResult.previousScanAt && (
                <div className="mt-2 rounded-md bg-danger/10 p-2 text-xs text-danger">
                  ⚠️ First admitted at: {new Date(scanResult.previousScanAt).toLocaleString()}
                </div>
              )}

              {/* Inspection Mode "Admit" Button */}
              {scanResult.result === "VALID" && (
                <div className="mt-3">
                  <Button variant="accent" onClick={admitInspected} className="w-full font-bold">
                    ✓ Confirm & Admit Attendee
                  </Button>
                </div>
              )}

              {/* Reversal action for used ticket */}
              {scanResult.result === "ALREADY_USED" && scanResult.ticket?.id && (
                <div className="mt-3">
                  <Button
                    variant="outline"
                    onClick={() => reverseCheckIn(scanResult.ticket.id)}
                    className="w-full text-xs text-slate hover:text-navy"
                  >
                    ↺ Reverse Check-In (Admin Reset)
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="mt-4 rounded-lg bg-paper p-3 text-xs text-slate">
            <span className="font-semibold text-navy">💡 Quick Tips:</span>
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              <li>Turn on "Auto-Admit" for fast line processing at the door.</li>
              <li>Turn off "Auto-Admit" to inspect attendee name and tier before admitting.</li>
              <li>Re-scanned tickets are rejected immediately with initial admission timestamps.</li>
            </ul>
          </div>
        </Card>

        {/* Sales & Real-time Check-In Audit Log */}
        <div className="space-y-4">
          {/* Ticket Sales Summary */}
          <Card className="p-4">
            <h2 className="mb-2 font-semibold text-navy">Ticket Tier Sales</h2>
            <div className="space-y-2">
              {data.sales.map((s) => (
                <div key={s.name} className="flex items-center justify-between rounded-lg bg-paper px-3 py-2 text-xs">
                  <span className="font-medium text-navy">{s.name}</span>
                  <span className="text-slate">
                    {s.quantity_sold} / {s.quantity_total} sold
                  </span>
                </div>
              ))}
            </div>
          </Card>

          {/* Recent Check-Ins Audit Log */}
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold text-navy">Live Gate Admissions ({checkins.length})</h2>
              <Button variant="ghost" onClick={load} className="text-xs">
                ↻ Refresh
              </Button>
            </div>

            {checkins.length === 0 ? (
              <p className="py-4 text-center text-xs text-slate">No attendees admitted yet for this event.</p>
            ) : (
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {checkins.map((chk) => (
                  <div
                    key={chk.id}
                    className={`flex items-center justify-between rounded-lg border p-2.5 text-xs ${
                      chk.is_reversal ? "border-warn/30 bg-warn/5" : "border-slate/15 bg-white"
                    }`}
                  >
                    <div>
                      <p className="font-semibold text-navy">
                        {chk.holder_name}{" "}
                        <span className="font-mono text-[10px] text-slate">({chk.ticket_number})</span>
                      </p>
                      <p className="text-[11px] text-slate">
                        {chk.ticket_type} · {new Date(chk.checked_in_at).toLocaleTimeString()}
                        {chk.staff_name && ` by ${chk.staff_name}`}
                      </p>
                      {chk.is_reversal && (
                        <p className="text-[10px] text-warn">
                          ↺ Reversed: {chk.notes || "Check-in reversed"}
                        </p>
                      )}
                    </div>

                    {!chk.is_reversal && (
                      <Button
                        variant="ghost"
                        onClick={() => reverseCheckIn(chk.ticket_id)}
                        disabled={reversingId === chk.ticket_id}
                        className="text-[11px] text-slate hover:text-danger"
                      >
                        {reversingId === chk.ticket_id ? "..." : "Reverse"}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Recurring Event Generator */}
          <Card className="p-4">
            <h2 className="mb-1 font-semibold text-navy">Make this a recurring event</h2>
            <p className="mb-3 text-xs text-slate">
              Generates future occurrences automatically published under the same club series.
            </p>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min="1"
                max="12"
                value={occCount}
                onChange={(e) => setOccCount(e.target.value)}
                className="w-20"
              />
              <span className="text-xs text-slate">weekly occurrences</span>
              <Button variant="outline" disabled={generating} onClick={generateOccurrences} className="text-xs">
                {generating ? "Generating..." : "Generate"}
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
