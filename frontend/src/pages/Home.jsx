import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Button, Card } from "../components/ui";

const MODULES = [
  { to: "/marketplace", emoji: "🛍️", title: "Marketplace", desc: "Buy from verified campus merchants." },
  { to: "/listings", emoji: "🔁", title: "Student-to-Student", desc: "Sell or find items other students are listing." },
  { to: "/rentals", emoji: "📦", title: "Borrow & Rent", desc: "Books, calculators, projectors, sports gear." },
  { to: "/events", emoji: "🎟️", title: "Events & Tickets", desc: "Discover events with secure, QR-verified tickets." },
];

export default function Home() {
  const { user } = useAuth();

  return (
    <div>
      <div className="rounded-2xl bg-navy px-8 py-14 text-center text-white">
        <h1 className="text-3xl font-bold sm:text-4xl">Welcome to CampusHub</h1>
        <p className="mx-auto mt-3 max-w-xl text-white/80">
          One trusted platform for campus commerce, borrowing, and events — built for the
          Graduation MVP described in the CampusHub SRS.
        </p>
        {!user && (
          <div className="mt-6 flex justify-center gap-3">
            <Button as={Link} to="/register" variant="accent">Create an account</Button>
            <Button as={Link} to="/login" variant="outline" className="border-white/40 text-white hover:bg-white/10">
              Log in
            </Button>
          </div>
        )}
        {user?.role === "student" && (
          <div className="mt-6 flex justify-center gap-3">
            <Button as={Link} to="/merchant-apply" variant="accent">Sell on CampusHub as a merchant</Button>
          </div>
        )}
      </div>

      <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {MODULES.map((m) => (
          <Link key={m.to} to={m.to}>
            <Card className="h-full p-5 transition hover:-translate-y-0.5 hover:shadow-md">
              <div className="text-3xl">{m.emoji}</div>
              <p className="mt-3 font-semibold text-navy">{m.title}</p>
              <p className="mt-1 text-sm text-slate">{m.desc}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
