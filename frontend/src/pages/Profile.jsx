import { useState } from "react";
import { client } from "../api/client";
import { useAuth, errMsg } from "../context/AuthContext";
import { Badge, Button, Card, ErrorBanner, Input, PageHeader, SuccessBanner, TextArea } from "../components/ui";

const PREF_LABELS = {
  orders: "Order updates",
  rentals: "Rental reminders & due dates",
  events: "Event & ticket updates",
  announcements: "University announcements",
};
const DEFAULT_PREFS = { orders: true, rentals: true, events: true, announcements: true };

export default function Profile() {
  const { user, reload } = useAuth();
  const [form, setForm] = useState({ name: user?.name || "", phone: user?.phone || "", bio: user?.bio || "" });
  const [prefs, setPrefs] = useState({ ...DEFAULT_PREFS, ...(user?.notification_prefs || {}) });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      await client.patch("/users/me", { ...form, notificationPrefs: prefs });
      await reload();
      setSuccess("Profile updated.");
    } catch (err) {
      setError(errMsg(err, "Could not update profile"));
    } finally {
      setSaving(false);
    }
  }

  if (!user) return null;

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="My Profile" />
      <Card className="p-6">
        <div className="mb-4 flex items-center gap-2">
          <Badge tone="navy">{user.role}</Badge>
          <Badge tone={user.verified ? "ok" : "warn"}>{user.verified ? "verified" : "unverified"}</Badge>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <ErrorBanner message={error} />
          <SuccessBanner message={success} />
          <Input label="Email" value={user.email} disabled className="bg-slate/5 text-slate" />
          <Input label="Full name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <TextArea label="Bio" value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} />

          <div>
            <p className="mb-2 text-sm font-medium text-navy">Notification preferences (FR-046)</p>
            <div className="space-y-2 rounded-lg border border-slate/15 p-3">
              {Object.entries(PREF_LABELS).map(([key, label]) => (
                <label key={key} className="flex items-center justify-between text-sm text-slate">
                  {label}
                  <input
                    type="checkbox"
                    checked={!!prefs[key]}
                    onChange={(e) => setPrefs({ ...prefs, [key]: e.target.checked })}
                    className="h-4 w-4 accent-navy"
                  />
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate">
              Security and ticket-cancellation notices are always sent regardless of these settings.
            </p>
          </div>

          <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save changes"}</Button>
        </form>
      </Card>
    </div>
  );
}
