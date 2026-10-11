import { Link } from "react-router-dom";
import { Button } from "../components/ui";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <p className="text-5xl">🧭</p>
      <h1 className="mt-4 text-xl font-bold text-navy">Page not found</h1>
      <p className="mt-2 text-sm text-slate">The page you're looking for doesn't exist or has moved.</p>
      <Button as={Link} to="/" className="mt-6">Back to home</Button>
    </div>
  );
}
