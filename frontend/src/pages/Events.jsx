import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Card, EmptyState, Spinner } from "../components/ui";

export default function Events() {
  const { user } = useAuth();
  const [events, setEvents] = useState(null);

  useEffect(() => {
    client.get("/events").then(({ data }) => setEvents(data.events));
  }, []);

  if (!events) return <div className="flex justify-center py-16"><Spinner /></div>;

  return (
    <div>
      <h1 className="text-2xl font-bold text-navy">Campus Events</h1>
      <p className="mt-1 text-sm text-slate">
        Approved, published events open for ticket sales.
        {user?.university_name && (
          <span className="block mt-0.5 text-xs font-medium text-accent-dark">
            📍 Viewing events at {user.university_name}
          </span>
        )}
      </p>

      {events.length === 0 ? (
        <EmptyState title="No published events right now" className="mt-6" />
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {events.map((e) => (
            <Link key={e.id} to={`/events/${e.id}`}>
              <Card className="h-full overflow-hidden transition hover:shadow-md">
                {e.poster_url && (
                  <div className="h-36 w-full overflow-hidden bg-navy/10">
                    <img src={e.poster_url} alt={e.title} className="h-full w-full object-cover transition hover:scale-105" />
                  </div>
                )}
                <div className="p-4">
                  <div className="flex items-center justify-between gap-1">
                    <p className="text-xs font-medium uppercase tracking-wide text-accent-dark">{e.organizer_name || e.club_name}</p>
                    {e.category && <span className="rounded-full bg-slate/10 px-2 py-0.5 text-[10px] text-slate">{e.category}</span>}
                  </div>
                  <p className="mt-1 font-semibold text-navy">{e.title}</p>
                  <p className="mt-1 text-sm text-slate">{new Date(e.date_time).toLocaleString()}</p>
                  <p className="text-sm text-slate">{e.venue_name || e.location}</p>
                  <p className="mt-2 text-xs text-slate">
                    {e.capacity_sold}/{e.capacity_total} tickets sold
                  </p>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
