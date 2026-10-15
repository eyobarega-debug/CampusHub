// Single source of truth for which tabs/routes each role can see.
// Navbar.jsx and App.jsx both read from here, so adding a tab means editing ONE place.
//
// Roles: student | merchant | organizer | admin | super_admin
// Admins (and super admins) see every tab.

export const ADMIN_ROLES = ["admin", "super_admin"];
export const ALL_ROLES = ["student", "merchant", "organizer", "admin", "super_admin"];

// roles: who sees the tab.  null/undefined = everyone (even logged-out visitors).
export const TABS = [
  // Public browsing tabs
  { key: "marketplace", label: "Marketplace", to: "/marketplace" },
  { key: "listings", label: "P2P", to: "/listings" },
  { key: "rentals", label: "Rentals", to: "/rentals" },
  { key: "events", label: "Events", to: "/events" },

  // Student-only tabs (+ admin sees all)
  { key: "orders", label: "My Orders", to: "/orders", roles: ["student", ...ADMIN_ROLES] },
  { key: "tickets", label: "My Tickets", to: "/tickets", roles: ["student", ...ADMIN_ROLES] },
  { key: "favorites", label: "Favorites", to: "/favorites", roles: ["student", "merchant", "organizer", ...ADMIN_ROLES] },

  // Shared logged-in tabs
  { key: "payments", label: "Payments", to: "/payment-approvals", roles: ["student", "merchant", "organizer", ...ADMIN_ROLES] },

  // Commissions: merchants/students see their own, admins see the admin view
  { key: "commissions", label: "Commissions", to: "/commissions", adminTo: "/admin/commissions", roles: ["student", "merchant", ...ADMIN_ROLES] },

  // Merchant-only (+ admin)
  { key: "merchant", label: "Merchant Dashboard", to: "/merchant", roles: ["merchant", ...ADMIN_ROLES] },

  // Organizer-only (+ admin)
  { key: "organizer", label: "Organizer", to: "/organizer", roles: ["organizer", ...ADMIN_ROLES] },

  // Admin-only
  { key: "admin", label: "Admin", to: "/admin", roles: ADMIN_ROLES },
];

export function canSee(tab, user) {
  if (!tab.roles) return true;
  if (!user) return false;
  return tab.roles.includes(user.role);
}

export function visibleTabs(user) {
  return TABS.filter((t) => canSee(t, user)).map((t) => ({
    ...t,
    to: user && ADMIN_ROLES.includes(user.role) && t.adminTo ? t.adminTo : t.to,
  }));
}

// Route-guard helper: rolesFor("orders") -> ["student","admin","super_admin"]
export function rolesFor(key) {
  return TABS.find((t) => t.key === key)?.roles;
}