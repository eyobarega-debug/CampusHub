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
              <Card className="h-full p-4 transition hover:shadow-md">
                <p className="text-xs font-medium uppercase tracking-wide text-accent-dark">{e.club_name}</p>
                <p className="mt-1 font-semibold text-navy">{e.title}</p>
                <p className="mt-1 text-sm text-slate">{new Date(e.date_time).toLocaleString()}</p>
                <p className="text-sm text-slate">{e.location}</p>
                <p className="mt-2 text-xs text-slate">
                  {e.capacity_sold}/{e.capacity_total} tickets sold
                </p>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
