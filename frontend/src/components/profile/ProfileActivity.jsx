import { Link } from "react-router-dom";
import { Badge, Card, EmptyState } from "../ui";

const TYPE_ICONS = {
  order: "🛍️",
  rental: "🔄",
  listing: "🏷️",
  ticket: "🎟️",
  product: "📦",
  event: "📅",
  audit: "📋",
};

const STATUS_TONES = {
  completed: "ok",
  confirmed: "ok",
  paid: "ok",
  active: "navy",
  published: "ok",
  approved: "ok",
  pending: "warn",
  pending_payment: "warn",
  cancelled: "danger",
  removed: "danger",
  disputed: "danger",
};

export default function ProfileActivity({ activities = [] }) {
  if (!activities || activities.length === 0) {
    return (
      <EmptyState
        title="No recent activity yet"
        subtitle="Your orders, rental bookings, listings, tickets, and events will appear here as you use CampusHub."
      />
    );
  }

  return (
    <div className="space-y-3">
      {activities.map((item, index) => {
        const icon = TYPE_ICONS[item.type] || "📌";
        const tone = STATUS_TONES[item.status] || "slate";
        const formattedDate = item.date
          ? new Date(item.date).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "";

        return (
          <Card
            key={`${item.type}-${item.id || index}`}
            className="flex flex-wrap items-center justify-between gap-3 p-4 transition hover:border-navy/30"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate/10 text-lg">
                {icon}
              </div>
              <div>
                <p className="font-medium text-navy">{item.title}</p>
                <p className="text-xs text-slate">{item.subtitle}</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {item.status && <Badge tone={tone}>{item.status}</Badge>}
              <span className="text-xs text-slate">{formattedDate}</span>
              {item.link && (
                <Link
                  to={item.link}
                  className="rounded-lg bg-slate/10 px-3 py-1 text-xs font-medium text-navy transition hover:bg-slate/20"
                >
                  View
                </Link>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
