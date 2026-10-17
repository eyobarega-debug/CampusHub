import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { client } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Badge, Button, Card, EmptyState, Spinner } from "../components/ui";
import ProfileHeader from "../components/profile/ProfileHeader";

export default function PublicProfile() {
  const { id } = useParams();
  const { user: currentUser } = useAuth();
  const [profile, setProfile] = useState(null);
  const [roleData, setRoleData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function fetchPublicProfile() {
      setLoading(true);
      setError("");
      try {
        const { data } = await client.get(`/users/${id}/public`);
        if (!cancelled) {
          setProfile(data.user);
          setRoleData(data.roleData || {});
        }
      } catch (err) {
        if (!cancelled) {
          setError(err?.response?.data?.error?.message || "Profile not found or unavailable");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchPublicProfile();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="mx-auto max-w-lg py-12 text-center">
        <EmptyState
          title="Profile Unavailable"
          subtitle={error || "The profile you are looking for does not exist or has been made private."}
          action={
            <Button as={Link} to="/" variant="primary" className="mt-4">
              Return to CampusHub Home
            </Button>
          }
        />
      </div>
    );
  }

  const isOwner = currentUser?.id === profile.id;
  const isCrossCampus = Boolean(
    currentUser?.university_id &&
    profile.university_id &&
    currentUser.university_id !== profile.university_id
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* Profile Header */}
      <ProfileHeader user={profile} isOwner={isOwner} />

      {/* Role-Specific Public Showcases */}
      {profile.role === "merchant" && (
        <div className="space-y-6">
          {roleData.store && (
            <Card className="p-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  {roleData.store.logo_url ? (
                    <img
                      src={roleData.store.logo_url}
                      alt={roleData.store.name}
                      className="h-16 w-16 rounded-xl object-cover border border-slate/15"
                    />
                  ) : (
                    <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-accent/15 text-2xl">
                      🏪
                    </div>
                  )}
                  <div>
                    <h2 className="text-xl font-bold text-navy">{roleData.store.name}</h2>
                    <p className="text-sm text-slate">{roleData.store.description || "Campus Merchant Store"}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge tone="accent">
                        ★ {roleData.rating || "5.0"} ({roleData.reviewCount || 0} reviews)
                      </Badge>
                      <Badge tone="ok">{roleData.store.status || "Active"}</Badge>
                    </div>
                  </div>
                </div>

                <Button as={Link} to={`/seller/${profile.id}`} variant="primary">
                  Visit Full Storefront
                </Button>
              </div>
            </Card>
          )}

          {/* Active Products Catalog */}
          <div>
            <h3 className="mb-3 text-lg font-bold text-navy">Products Available</h3>
            {roleData.activeProducts && roleData.activeProducts.length > 0 ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
                {roleData.activeProducts.map((prod) => (
                  <Card key={prod.id} className="overflow-hidden transition hover:shadow-md">
                    <div className="h-36 w-full bg-slate/10">
                      {prod.images?.[0] ? (
                        <img src={prod.images[0]} alt={prod.title} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-slate/40 text-2xl">
                          📦
                        </div>
                      )}
                    </div>
                    <div className="p-3">
                      <h4 className="font-semibold text-navy truncate" title={prod.title}>
                        {prod.title}
                      </h4>
                      <p className="mt-1 text-sm font-bold text-navy">${prod.price}</p>
                      <Button
                        as={Link}
                        to={`/marketplace/${prod.id}`}
                        variant="outline"
                        className="mt-2 w-full text-xs"
                      >
                        View Product
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <EmptyState title="No active products listed at this time." />
            )}
          </div>
        </div>
      )}

      {profile.role === "organizer" && (
        <div className="space-y-6">
          {roleData.club && (
            <Card className="p-6">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-ok/15 text-2xl">
                  🏛️
                </div>
                <div>
                  <h2 className="text-xl font-bold text-navy">{roleData.club.name}</h2>
                  <p className="text-xs text-slate">Official Campus Organization / Club</p>
                  <div className="mt-1">
                    <Badge tone="ok">{roleData.club.status || "Active Club"}</Badge>
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* Upcoming Events */}
          <div>
            <h3 className="mb-3 text-lg font-bold text-navy">Upcoming Campus Events</h3>
            {roleData.upcomingEvents && roleData.upcomingEvents.length > 0 ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {roleData.upcomingEvents.map((evt) => (
                  <Card key={evt.id} className="p-4 transition hover:border-navy/30">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h4 className="font-bold text-navy">{evt.title}</h4>
                        <p className="mt-1 text-xs text-slate">
                          📍 {evt.location || "Campus Venue"}
                        </p>
                        <p className="text-xs text-slate">
                          🗓️ {new Date(evt.date_time).toLocaleString()}
                        </p>
                      </div>
                      <Badge tone="ok">Open</Badge>
                    </div>
                    {evt.description && (
                      <p className="mt-2 text-xs text-navy/80 line-clamp-2">{evt.description}</p>
                    )}
                    <div className="mt-3 flex justify-end">
                      <Button as={Link} to={`/events/${evt.id}`} variant="outline" className="text-xs">
                        View Event & Tickets
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <EmptyState title="No upcoming events scheduled right now." />
            )}
          </div>
        </div>
      )}

      {profile.role === "student" && (
        <div className="space-y-6">
          {isCrossCampus && (
            <div className="flex items-center gap-2 rounded-lg border border-navy/15 bg-navy/5 px-4 py-3 text-xs text-slate">
              <span>🔒</span>
              <span>Some marketplace and rental activity is only visible to members of the same campus.</span>
            </div>
          )}

          {/* Active P2P Resale Listings */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-bold text-navy">Resale Marketplace Items</h3>
              {roleData.sellerRating > 0 && (
                <Badge tone="accent">
                  ★ {roleData.sellerRating} ({roleData.reviewCount} reviews)
                </Badge>
              )}
            </div>

            {roleData.activeListings && roleData.activeListings.length > 0 ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
                {roleData.activeListings.map((item) => (
                  <Card key={item.id} className="overflow-hidden transition hover:shadow-md">
                    <div className="h-32 w-full bg-slate/10">
                      {item.images?.[0] ? (
                        <img src={item.images[0]} alt={item.title} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-slate/40 text-xl">
                          🏷️
                        </div>
                      )}
                    </div>
                    <div className="p-3">
                      <h4 className="font-semibold text-navy truncate" title={item.title}>
                        {item.title}
                      </h4>
                      <p className="mt-1 text-sm font-bold text-navy">${item.price}</p>
                      {item.condition && (
                        <span className="text-[11px] text-slate">Condition: {item.condition}</span>
                      )}
                      <Button
                        as={Link}
                        to={`/listings/${item.id}`}
                        variant="outline"
                        className="mt-2 w-full text-xs"
                      >
                        View Listing
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <EmptyState title="No items currently listed for resale." />
            )}
          </div>

          {/* Active Rental Items */}
          {roleData.activeRentals && roleData.activeRentals.length > 0 && (
            <div>
              <h3 className="mb-3 text-lg font-bold text-navy">Available Equipment for Rent</h3>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
                {roleData.activeRentals.map((rental) => (
                  <Card key={rental.id} className="overflow-hidden transition hover:shadow-md">
                    <div className="h-32 w-full bg-slate/10">
                      {rental.images?.[0] ? (
                        <img src={rental.images[0]} alt={rental.title} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-slate/40 text-xl">
                          🔄
                        </div>
                      )}
                    </div>
                    <div className="p-3">
                      <h4 className="font-semibold text-navy truncate" title={rental.title}>
                        {rental.title}
                      </h4>
                      <p className="mt-1 text-sm font-bold text-navy">
                        ${rental.price_per_day} <span className="text-xs font-normal text-slate">/ day</span>
                      </p>
                      <Button
                        as={Link}
                        to={`/rentals/${rental.id}`}
                        variant="outline"
                        className="mt-2 w-full text-xs"
                      >
                        Rent Item
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
