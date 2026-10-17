import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { client } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Badge, Button, Card, ErrorBanner, PageHeader, Spinner, SuccessBanner } from "../components/ui";
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

export default function TicketVerifyPage() {
  const { token } = useParams();
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [activeToken, setActiveToken] = useState(token || "");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [reversing, setReversing] = useState(false);

  async function inspectToken(rawToken) {
    if (!rawToken) return;
    setLoading(true);
    setError("");
    setSuccess("");
    setActiveToken(rawToken);

    try {
      const { data } = await client.post("/tickets/scan", {
        qrToken: rawToken,
        action: "inspect",
      });
      setScanResult(data);
    } catch (err) {
      const code = err?.response?.data?.error?.code;
      const msg = err?.response?.data?.error?.message;
      if (code === "FORBIDDEN_CROSS_CAMPUS" || (err?.response?.status === 403 && msg?.toLowerCase().includes("another university"))) {
        const crossCampusMsg = "This ticket belongs to another university and cannot be verified here.";
        setError(crossCampusMsg);
        setScanResult({ result: "FORBIDDEN_CROSS_CAMPUS", reason: crossCampusMsg });
      } else {
        setError(msg || "Verification failed");
        setScanResult({ result: "INVALID", reason: msg || "Scan failed" });
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (token) {
      inspectToken(token);
    }
  }, [token]);

  async function handleAdmit() {
    if (!activeToken) return;
    setLoading(true);
    setError("");
    setSuccess("");
    try {
      const { data } = await client.post("/tickets/scan", {
        qrToken: activeToken,
        action: "check_in",
      });
      setScanResult(data);
      if (data.result === "ADMIT") {
        setSuccess(`Admitted: ${data.ticket?.holder_name || "Attendee"}`);
      }
    } catch (err) {
      setError(err?.response?.data?.error?.message || "Check-in failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleReverse() {
    if (!scanResult?.ticket?.id) return;
    const reason = window.prompt("Reason for check-in reversal:", "Staff gate correction");
    if (!reason) return;
    setReversing(true);
    setError("");
    setSuccess("");
    try {
      await client.post(`/tickets/${scanResult.ticket.id}/reverse-checkin`, { reason });
      setSuccess("Check-in reversed successfully. Ticket is active again.");
      await inspectToken(activeToken);
    } catch (err) {
      setError(err?.response?.data?.error?.message || "Failed to reverse check-in");
    } finally {
      setReversing(false);
    }
  }

  const isAuthorized = user && ["organizer", "admin", "super_admin"].includes(user.role);

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        title="Gate Verification & Ticket Inspection"
        subtitle="Gibiyachin official cryptographic ticket verification system."
      />

      <ErrorBanner message={error} />
      <SuccessBanner message={success} />

      {!isAuthorized ? (
        <Card className="p-6 text-center">
          <p className="font-semibold text-navy">Staff Authorization Required</p>
          <p className="mt-1 text-sm text-slate">
            You must be logged in as an event organizer or university administrator to admit attendees.
          </p>
          <Button as={Link} to="/login" variant="accent" className="mt-4">
            Log In as Staff
          </Button>
        </Card>
      ) : (
        <div className="space-y-5">
          {!token && (
            <Card className="p-5">
              <h2 className="mb-3 font-semibold text-navy">Scan Ticket QR Code</h2>
              <QrScanner onScan={inspectToken} />
            </Card>
          )}

          {loading && (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          )}

          {scanResult && !loading && (
            <Card
              className={`overflow-hidden border-2 p-6 transition ${
                scanResult.result === "VALID" || scanResult.result === "ADMIT"
                  ? "border-ok bg-ok/5"
                  : scanResult.result === "PAYMENT_NOT_APPROVED"
                  ? "border-warn bg-warn/5"
                  : "border-danger bg-danger/5"
              }`}
            >
              <div className="text-center">
                <Badge
                  tone={
                    scanResult.result === "VALID" || scanResult.result === "ADMIT"
                      ? "ok"
                      : scanResult.result === "PAYMENT_NOT_APPROVED"
                      ? "warn"
                      : "danger"
                  }
                >
                  {RESULT_STYLE[scanResult.result]?.label || scanResult.result}
                </Badge>

                <h2 className="mt-3 text-xl font-bold text-navy">
                  {scanResult.eventTitle || scanResult.ticket?.event_title || "Campus Event"}
                </h2>
              </div>

              {/* Attendee Details Card */}
              {(scanResult.ticket || scanResult.attendeeName) && (
                <div className="mt-4 rounded-xl border border-slate/15 bg-white p-4 shadow-xs">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-[10px] font-semibold text-slate uppercase">Attendee</span>
                      <p className="font-bold text-navy">
                        {scanResult.attendeeName || scanResult.ticket?.holder_name}
                      </p>
                    </div>
                    <div>
                      <span className="text-[10px] font-semibold text-slate uppercase">Ticket Number</span>
                      <p className="font-mono font-bold text-navy">
                        {scanResult.ticketNumber || scanResult.ticket?.ticket_number || scanResult.ticket?.id?.slice(0, 8)}
                      </p>
                    </div>
                    <div>
                      <span className="text-[10px] font-semibold text-slate uppercase">Ticket Tier</span>
                      <p className="font-medium text-navy">
                        {scanResult.ticketType || scanResult.ticket?.ticket_type}
                      </p>
                    </div>
                    <div>
                      <span className="text-[10px] font-semibold text-slate uppercase">Campus</span>
                      <p className="font-medium text-navy">
                        {scanResult.ticket?.university_name || "Campus Community"}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {scanResult.reason && (
                <p className="mt-3 text-center text-xs text-slate">{scanResult.reason}</p>
              )}

              {scanResult.previousScanAt && (
                <div className="mt-3 rounded-lg bg-danger/10 p-2.5 text-center text-xs text-danger font-medium">
                  ⚠️ This ticket was already admitted on:{" "}
                  {new Date(scanResult.previousScanAt).toLocaleString()}
                </div>
              )}

              {/* Actions */}
              <div className="mt-5 space-y-2">
                {scanResult.result === "VALID" && (
                  <Button variant="accent" onClick={handleAdmit} className="w-full text-base font-bold">
                    ✓ Confirm & Admit Attendee
                  </Button>
                )}

                {scanResult.result === "ALREADY_USED" && scanResult.ticket?.id && (
                  <Button
                    variant="outline"
                    onClick={handleReverse}
                    disabled={reversing}
                    className="w-full text-xs text-slate hover:text-danger"
                  >
                    {reversing ? "Reversing..." : "↺ Reverse Check-In (Admin Reset)"}
                  </Button>
                )}

                {token && (
                  <Button as={Link} to="/tickets/verify" variant="ghost" className="w-full text-xs">
                    ← Scan Another Ticket
                  </Button>
                )}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
