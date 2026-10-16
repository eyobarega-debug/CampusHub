import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { client } from "../api/client";
import { Button, Card, Spinner } from "../components/ui";
import ProfileHeader from "../components/profile/ProfileHeader";
import ProfileStats from "../components/profile/ProfileStats";
import ProfileActivity from "../components/profile/ProfileActivity";
import ProfileSettings from "../components/profile/ProfileSettings";
import EditProfileModal from "../components/profile/EditProfileModal";

export default function Profile() {
  const { user, reload } = useAuth();
  const [activeTab, setActiveTab] = useState("overview"); // 'overview' | 'activity' | 'settings'
  const [stats, setStats] = useState(null);
  const [activities, setActivities] = useState([]);
  const [loadingData, setLoadingData] = useState(true);
  const [isEditOpen, setIsEditOpen] = useState(false);

  const fetchProfileData = useCallback(async () => {
    if (!user) return;
    try {
      const [statsRes, activityRes] = await Promise.all([
        client.get("/users/me/stats"),
        client.get("/users/me/activity"),
      ]);
      setStats(statsRes.data?.stats || null);
      setActivities(activityRes.data?.activities || []);
    } catch (err) {
      console.error("Failed to fetch profile stats/activity:", err);
    } finally {
      setLoadingData(false);
    }
  }, [user]);

  useEffect(() => {
    fetchProfileData();
  }, [fetchProfileData]);

  async function handleProfileUpdated() {
    await reload();
    await fetchProfileData();
  }

  if (!user) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  const role = user.role || "student";

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* Profile Header */}
      <ProfileHeader
        user={user}
        isOwner={true}
        onEditClick={() => setIsEditOpen(true)}
        onProfileUpdated={handleProfileUpdated}
      />

      {/* Tabs Navigation */}
      <div className="flex border-b border-slate/20">
        <button
          type="button"
          onClick={() => setActiveTab("overview")}
          className={`flex items-center gap-2 border-b-2 px-5 py-3 text-sm font-semibold transition ${
            activeTab === "overview"
              ? "border-navy text-navy"
              : "border-transparent text-slate hover:text-navy"
          }`}
        >
          📊 Overview & Stats
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("activity")}
          className={`flex items-center gap-2 border-b-2 px-5 py-3 text-sm font-semibold transition ${
            activeTab === "activity"
              ? "border-navy text-navy"
              : "border-transparent text-slate hover:text-navy"
          }`}
        >
          ⏱️ Activity Feed
          {activities.length > 0 && (
            <span className="rounded-full bg-slate/10 px-2 py-0.5 text-xs text-slate">
              {activities.length}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("settings")}
          className={`flex items-center gap-2 border-b-2 px-5 py-3 text-sm font-semibold transition ${
            activeTab === "settings"
              ? "border-navy text-navy"
              : "border-transparent text-slate hover:text-navy"
          }`}
        >
          ⚙️ Account Settings
        </button>
      </div>

      {/* Tab Contents */}
      {loadingData ? (
        <div className="flex h-40 items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <>
          {activeTab === "overview" && (
            <div className="space-y-6">
              {/* Role-Specific Metrics */}
              <div>
                <h3 className="mb-3 text-base font-bold text-navy">Platform Statistics</h3>
                <ProfileStats stats={stats} role={role} />
              </div>

              {/* Role-Specific Quick Shortcuts & Showcase */}
              {role === "student" && (
                <div className="grid gap-4 sm:grid-cols-3">
                  <Card className="p-4">
                    <p className="font-semibold text-navy">🛍️ Orders & Resale</p>
                    <p className="mt-1 text-xs text-slate">
                      Browse your active purchases and peer-to-peer listings on campus.
                    </p>
                    <div className="mt-3 flex gap-2">
                      <Button as={Link} to="/orders" variant="outline" className="text-xs">
                        My Orders
                      </Button>
                      <Button as={Link} to="/listings" variant="ghost" className="text-xs">
                        P2P Market
                      </Button>
                    </div>
                  </Card>

                  <Card className="p-4">
                    <p className="font-semibold text-navy">🔄 Rentals & Borrowing</p>
                    <p className="mt-1 text-xs text-slate">
                      Track your equipment, book rentals, and return due dates.
                    </p>
                    <div className="mt-3 flex gap-2">
                      <Button as={Link} to="/rentals/mine" variant="outline" className="text-xs">
                        My Bookings
                      </Button>
                      <Button as={Link} to="/rentals" variant="ghost" className="text-xs">
                        Browse Items
                      </Button>
                    </div>
                  </Card>

                  <Card className="p-4">
                    <p className="font-semibold text-navy">🎟️ Campus Events</p>
                    <p className="mt-1 text-xs text-slate">
                      View your registered event tickets, club workshops, and QR passes.
                    </p>
                    <div className="mt-3 flex gap-2">
                      <Button as={Link} to="/tickets" variant="outline" className="text-xs">
                        My Tickets
                      </Button>
                      <Button as={Link} to="/events" variant="ghost" className="text-xs">
                        Find Events
                      </Button>
                    </div>
                  </Card>
                </div>
              )}

              {role === "merchant" && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Card className="p-5">
                    <h4 className="font-bold text-navy">🏪 Merchant Storefront</h4>
                    <p className="mt-1 text-xs text-slate">
                      Manage your campus store catalog, upload new products, and configure store policies.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button as={Link} to="/merchant" variant="primary">
                        Merchant Dashboard
                      </Button>
                      <Button as={Link} to={`/seller/${user.id}`} variant="outline">
                        View Storefront
                      </Button>
                    </div>
                  </Card>

                  <Card className="p-5">
                    <h4 className="font-bold text-navy">💳 Payouts & Commissions</h4>
                    <p className="mt-1 text-xs text-slate">
                      Track your earnings, commission rates, and linked bank or mobile money payout accounts.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button as={Link} to="/commissions" variant="outline">
                        My Commissions
                      </Button>
                      <Button as={Link} to="/payout-accounts" variant="outline">
                        Payout Accounts
                      </Button>
                    </div>
                  </Card>
                </div>
              )}

              {role === "organizer" && (
                <Card className="p-5">
                  <h4 className="font-bold text-navy">📅 Event Organizer Center</h4>
                  <p className="mt-1 text-xs text-slate">
                    Create new student events, manage ticket capacities, and validate attendee entry via QR check-in.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <Button as={Link} to="/organizer" variant="primary">
                      Manage Events
                    </Button>
                    <Button as={Link} to="/events" variant="outline">
                      Campus Event Board
                    </Button>
                  </div>
                </Card>
              )}

              {(role === "admin" || role === "super_admin") && (
                <Card className="p-5">
                  <h4 className="font-bold text-navy">🛡️ University Administration</h4>
                  <p className="mt-1 text-xs text-slate">
                    Review verification requests, manage student dispute cases, and monitor platform activity.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <Button as={Link} to="/admin" variant="primary">
                      Admin Console
                    </Button>
                    <Button as={Link} to="/payment-approvals" variant="outline">
                      Payment Approvals
                    </Button>
                    <Button as={Link} to="/admin/commissions" variant="outline">
                      Commission Settings
                    </Button>
                  </div>
                </Card>
              )}
            </div>
          )}

          {activeTab === "activity" && (
            <ProfileActivity activities={activities} />
          )}

          {activeTab === "settings" && (
            <ProfileSettings user={user} onProfileUpdated={handleProfileUpdated} />
          )}
        </>
      )}

      {/* Edit Profile Modal */}
      <EditProfileModal
        user={user}
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        onSaved={handleProfileUpdated}
      />
    </div>
  );
}
