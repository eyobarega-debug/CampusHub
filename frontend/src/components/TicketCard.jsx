import { useState } from "react";
import { Badge, Button } from "./ui";
import ManualPaymentStatus from "./ManualPaymentStatus";

const STATUS_CONFIG = {
  active: { tone: "ok", label: "VALID — READY FOR ENTRY" },
  used: { tone: "slate", label: "ADMITTED — ALREADY USED" },
  reserved: { tone: "warn", label: "RESERVED — PENDING PAYMENT" },
  cancelled: { tone: "danger", label: "CANCELLED / VOID" },
  expired: { tone: "danger", label: "EXPIRED" },
};

export default function TicketCard({
  ticket,
  onCancel,
  onCancelUnpaid,
  isPreview = false,
  showActions = true,
  className = "",
}) {
  const [copied, setCopied] = useState(false);

  if (!ticket) return null;

  const status = ticket.status || "active";
  const statusInfo = STATUS_CONFIG[status] || { tone: "slate", label: status.toUpperCase() };

  const startFormatted = ticket.date_time
    ? new Date(ticket.date_time).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "TBA";

  const endFormatted = ticket.end_time
    ? new Date(ticket.end_time).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  const venueDisplay = ticket.venue_name || ticket.location || "Campus Venue";
  const addressDisplay = ticket.venue_address;
  const organizerDisplay = ticket.organizer_name || ticket.club_name || "Event Organizer";
  const priceDisplay = Number(ticket.price) > 0 ? `${Number(ticket.price).toFixed(2)} ETB` : "FREE ADMISSION";
  const ticketNumber = ticket.ticket_number || (ticket.id ? `GIB-${ticket.id.slice(0, 8).toUpperCase()}` : "GIB-SAMPLE");

  function copyTicketNumber() {
    if (ticketNumber && navigator.clipboard) {
      navigator.clipboard.writeText(ticketNumber);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function handlePrint() {
    window.print();
  }

  return (
    <div
      className={`ticket-pass relative overflow-hidden rounded-2xl border border-slate/20 bg-white shadow-md transition hover:shadow-lg ${className}`}
      id={`ticket-pass-${ticket.id || "preview"}`}
    >
      {/* Visual Header / Poster Banner */}
      <div className="relative h-44 w-full overflow-hidden bg-gradient-to-r from-navy via-slate to-navy">
        {ticket.poster_url ? (
          <img
            src={ticket.poster_url}
            alt={ticket.event_title || "Event poster"}
            className="h-full w-full object-cover object-center"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-6 text-center">
            <div>
              <span className="text-3xl font-extrabold tracking-wider text-white/30">ግቢያችን</span>
              <p className="mt-1 text-xs tracking-widest text-white/70 uppercase">Gibiyachin Official Campus Event</p>
            </div>
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent" />

        <div className="absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 backdrop-blur-sm">
          <span className="text-xs font-bold tracking-wider text-accent">ግቢያችን</span>
          <span className="text-[10px] text-white/80">· Gibiyachin Pass</span>
        </div>

        {ticket.category && (
          <div className="absolute top-3 right-3 rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-semibold text-white backdrop-blur-sm">
            {ticket.category}
          </div>
        )}

        <div className="absolute right-4 bottom-3 left-4 text-white">
          <p className="text-xs font-medium tracking-wide text-accent-light uppercase">
            {organizerDisplay}
          </p>
          <h3 className="line-clamp-1 text-lg font-bold text-white drop-shadow-sm">
            {ticket.event_title || "Event Title"}
          </h3>
        </div>
      </div>

      {/* Ticket Body: Details & QR */}
      <div className="p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate/15 pb-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate uppercase">Ticket No:</span>
            <button
              type="button"
              onClick={copyTicketNumber}
              title="Click to copy ticket number"
              className="group flex items-center gap-1 font-mono text-sm font-bold text-navy hover:text-accent"
            >
              <span>{ticketNumber}</span>
              <span className="text-[10px] text-slate group-hover:text-accent">
                {copied ? "✓ copied" : "📋"}
              </span>
            </button>
          </div>
          <Badge tone={statusInfo.tone}>{statusInfo.label}</Badge>
        </div>

        {/* Event Schedule & Venue */}
        <div className="mb-5 grid grid-cols-1 gap-3 rounded-xl bg-paper p-3.5 sm:grid-cols-2">
          <div>
            <span className="block text-[11px] font-semibold tracking-wider text-slate uppercase">Date & Time</span>
            <p className="mt-0.5 text-sm font-semibold text-navy">{startFormatted}</p>
            {endFormatted && (
              <p className="text-xs text-slate">Until {endFormatted}</p>
            )}
          </div>
          <div>
            <span className="block text-[11px] font-semibold tracking-wider text-slate uppercase">Venue & Location</span>
            <p className="mt-0.5 text-sm font-semibold text-navy">{venueDisplay}</p>
            {addressDisplay && (
              <p className="text-xs text-slate">{addressDisplay}</p>
            )}
          </div>
        </div>

        {/* Attendee & Ticket Type Info */}
        <div className="mb-5 grid grid-cols-2 gap-3 border-b border-slate/15 pb-4 sm:grid-cols-4">
          <div>
            <span className="block text-[10px] font-semibold tracking-wider text-slate uppercase">Attendee</span>
            <p className="mt-0.5 text-sm font-medium text-navy">{ticket.holder_name || "Student"}</p>
          </div>
          <div>
            <span className="block text-[10px] font-semibold tracking-wider text-slate uppercase">Campus</span>
            <p className="mt-0.5 text-sm font-medium text-navy">{ticket.university_name || "Campus Community"}</p>
          </div>
          <div>
            <span className="block text-[10px] font-semibold tracking-wider text-slate uppercase">Tier / Type</span>
            <p className="mt-0.5 text-sm font-medium text-navy">{ticket.ticket_type || "General"}</p>
          </div>
          <div>
            <span className="block text-[10px] font-semibold tracking-wider text-slate uppercase">Price</span>
            <p className="mt-0.5 text-sm font-semibold text-navy">{priceDisplay}</p>
          </div>
        </div>

        {/* QR Code Presentation */}
        {(status === "active" || status === "used") && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate/30 bg-paper/60 p-5 text-center">
            {ticket.qrDataUrl ? (
              <div className="relative rounded-xl border-2 border-navy/20 bg-white p-3 shadow-sm">
                <img
                  src={ticket.qrDataUrl}
                  alt={`QR code for ticket ${ticketNumber}`}
                  className="h-44 w-44 object-contain"
                />
                {status === "used" && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/65 backdrop-blur-[1px]">
                    <span className="rotate-[-12deg] rounded-md border-2 border-danger bg-danger/90 px-3 py-1 font-mono text-sm font-extrabold tracking-wider text-white">
                      ADMITTED
                    </span>
                  </div>
                )}
              </div>
            ) : isPreview ? (
              <div className="flex h-44 w-44 items-center justify-center rounded-xl border-2 border-dashed border-slate/30 bg-white text-xs text-slate">
                Live QR generated upon purchase
              </div>
            ) : (
              <div className="text-xs text-slate">QR code will appear when active</div>
            )}

            <p className="mt-3 font-mono text-xs font-semibold tracking-wider text-navy">
              {ticketNumber}
            </p>
            <p className="mt-1 text-xs text-slate">
              {status === "active"
                ? "Present this QR pass at the entrance. Scanned once, then invalidated."
                : "This ticket has already been verified and admitted at the entrance."}
            </p>
          </div>
        )}

        {/* Pending Payment Flow */}
        {status === "reserved" && (
          <div className="mt-2 space-y-3">
            <ManualPaymentStatus
              paymentId={ticket.payment_id}
              status={ticket.payment_status}
              provider={ticket.payment_provider}
              rejectReason={ticket.payment_reject_reason}
              returnTo="/tickets"
              label={`Ticket: ${ticket.event_title}`}
            />
            {ticket.payment_status === "pending" && onCancelUnpaid && (
              <Button
                variant="ghost"
                className="w-full text-xs text-danger hover:bg-danger/10"
                onClick={() => onCancelUnpaid(ticket)}
              >
                Cancel Unpaid Reservation
              </Button>
            )}
          </div>
        )}

        {/* Branding & Anti-Counterfeit Verification Footer */}
        <div className="mt-5 flex items-center justify-between border-t border-slate/15 pt-3 text-[11px] text-slate">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-navy">ግቢያችን Gibiyachin</span>
            <span>· Campus Marketplace</span>
          </div>
          <span className="italic">Cryptographically Verified</span>
        </div>

        {/* Actions Bar (Screen Only) */}
        {showActions && !isPreview && (
          <div className="no-print mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-slate/15 pt-3">
            {(status === "active" || status === "used") && (
              <Button variant="outline" onClick={handlePrint} className="text-xs">
                🖨️ Print / Save Pass
              </Button>
            )}
            {status === "active" && onCancel && (
              <Button
                variant="ghost"
                onClick={() => onCancel(ticket.id)}
                className="text-xs text-danger hover:bg-danger/10"
              >
                Cancel Ticket
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Print-specific layout overrides */}
      <style>{`
        @media print {
          body * {
            visibility: hidden;
          }
          .ticket-pass, .ticket-pass * {
            visibility: visible;
          }
          .ticket-pass {
            position: absolute;
            left: 0;
            top: 0;
            width: 100% !important;
            max-width: 600px !important;
            margin: 0 auto !important;
            box-shadow: none !important;
            border: 1px solid #1f3b57 !important;
            page-break-inside: avoid !important;
          }
          .no-print {
            display: none !important;
          }
        }
      `}</style>
    </div>
  );
}
