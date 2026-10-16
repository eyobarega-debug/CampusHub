import { Card } from "../ui";

export default function ProfileStats({ stats, role = "student" }) {
  if (!stats) return null;

  if (role === "student") {
    const items = [
      { label: "Orders Placed", value: stats.ordersCount || 0, icon: "🛍️" },
      { label: "Rental Bookings", value: stats.bookingsCount || 0, icon: "🔄" },
      { label: "P2P Listings", value: stats.listingsCount || 0, icon: "🏷️" },
      { label: "Event Tickets", value: stats.ticketsCount || 0, icon: "🎟️" },
      { label: "Saved Favorites", value: stats.favoritesCount || 0, icon: "❤️" },
      { label: "Reviews Given", value: stats.reviewsGiven || 0, icon: "⭐" },
    ];

    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {items.map((it) => (
          <Card key={it.label} className="p-4 text-center transition hover:border-navy/30">
            <span className="text-2xl">{it.icon}</span>
            <p className="mt-1 text-2xl font-bold text-navy">{it.value}</p>
            <p className="text-xs font-medium text-slate">{it.label}</p>
          </Card>
        ))}
      </div>
    );
  }

  if (role === "merchant") {
    const items = [
      { label: "Active Products", value: `${stats.activeProducts || 0} / ${stats.totalProducts || 0}`, icon: "📦" },
      { label: "Total Orders", value: stats.totalOrders || 0, icon: "📑" },
      { label: "Completed Orders", value: stats.completedOrders || 0, icon: "✅" },
      {
        label: "Total Revenue",
        value: `$${Number(stats.totalRevenue || 0).toFixed(2)}`,
        icon: "💰",
      },
      {
        label: "Seller Rating",
        value: stats.ratingCount > 0 ? `★ ${stats.averageRating} (${stats.ratingCount})` : "New Seller",
        icon: "⭐",
      },
      {
        label: "Store Status",
        value: stats.hasStore ? (stats.storeStatus || "Active") : "No Store",
        icon: "🏪",
      },
    ];

    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {items.map((it) => (
          <Card key={it.label} className="p-4 text-center transition hover:border-navy/30">
            <span className="text-2xl">{it.icon}</span>
            <p className="mt-1 text-xl font-bold text-navy">{it.value}</p>
            <p className="text-xs font-medium text-slate">{it.label}</p>
          </Card>
        ))}
      </div>
    );
  }

  if (role === "organizer") {
    const items = [
      { label: "Events Created", value: stats.totalEvents || 0, icon: "📅" },
      { label: "Upcoming Events", value: stats.upcomingEvents || 0, icon: "⏳" },
      { label: "Completed Events", value: stats.completedEvents || 0, icon: "🏆" },
      { label: "Tickets Sold", value: stats.ticketsSold || 0, icon: "🎟️" },
      { label: "Total Attendees", value: stats.totalAttendees || 0, icon: "👥" },
      { label: "Club Status", value: stats.hasClub ? (stats.clubStatus || "Active") : "No Club", icon: "🏛️" },
    ];

    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {items.map((it) => (
          <Card key={it.label} className="p-4 text-center transition hover:border-navy/30">
            <span className="text-2xl">{it.icon}</span>
            <p className="mt-1 text-2xl font-bold text-navy">{it.value}</p>
            <p className="text-xs font-medium text-slate">{it.label}</p>
          </Card>
        ))}
      </div>
    );
  }

  if (role === "admin" || role === "super_admin") {
    const items = [
      { label: "Users Managed", value: stats.usersManaged || 0, icon: "👥" },
      { label: "Active Stores", value: stats.merchantsCount || 0, icon: "🏪" },
      { label: "Active Clubs", value: stats.clubsCount || 0, icon: "🏛️" },
      { label: "Open Reports", value: stats.openReports || 0, icon: "⚠️" },
      { label: "Platform Orders", value: stats.totalOrders || 0, icon: "🛍️" },
      {
        label: "Platform Revenue",
        value: `$${Number(stats.platformRevenue || 0).toFixed(2)}`,
        icon: "📈",
      },
    ];

    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {items.map((it) => (
          <Card key={it.label} className="p-4 text-center transition hover:border-navy/30">
            <span className="text-2xl">{it.icon}</span>
            <p className="mt-1 text-xl font-bold text-navy">{it.value}</p>
            <p className="text-xs font-medium text-slate">{it.label}</p>
          </Card>
        ))}
      </div>
    );
  }

  return null;
}
