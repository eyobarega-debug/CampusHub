import { useState, useRef } from "react";
import { Link } from "react-router-dom";
import { Badge, Button } from "../ui";
import { client } from "../../api/client";

const ROLE_COLORS = {
  student: "navy",
  merchant: "accent",
  organizer: "ok",
  admin: "danger",
  super_admin: "warn",
};

const ROLE_LABELS = {
  student: "Student",
  merchant: "Merchant",
  organizer: "Event Organizer",
  admin: "Administrator",
  super_admin: "Super Admin",
};

export default function ProfileHeader({
  user,
  isOwner = false,
  onEditClick,
  onProfileUpdated,
}) {
  const [uploadingCover, setUploadingCover] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [copied, setCopied] = useState(false);
  const coverInputRef = useRef(null);
  const avatarInputRef = useRef(null);

  if (!user) return null;

  async function handleCoverUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      alert("Cover image must be under 5MB");
      return;
    }
    setUploadingCover(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const { data: uploadRes } = await client.post("/uploads", formData);
      await client.patch("/users/me", { coverImageUrl: uploadRes.url });
      if (onProfileUpdated) await onProfileUpdated();
    } catch (err) {
      alert(err?.response?.data?.error?.message || "Failed to upload cover");
    } finally {
      setUploadingCover(false);
      if (coverInputRef.current) coverInputRef.current.value = "";
    }
  }

  async function handleRemoveCover() {
    if (!confirm("Are you sure you want to remove your cover photo?")) return;
    setUploadingCover(true);
    try {
      await client.patch("/users/me", { coverImageUrl: null });
      if (onProfileUpdated) await onProfileUpdated();
    } catch (err) {
      alert(err?.response?.data?.error?.message || "Failed to remove cover");
    } finally {
      setUploadingCover(false);
    }
  }

  async function handleAvatarUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      alert("Avatar image must be under 5MB");
      return;
    }
    setUploadingAvatar(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const { data: uploadRes } = await client.post("/uploads", formData);
      await client.patch("/users/me", { avatarUrl: uploadRes.url });
      if (onProfileUpdated) await onProfileUpdated();
    } catch (err) {
      alert(err?.response?.data?.error?.message || "Failed to update profile photo");
    } finally {
      setUploadingAvatar(false);
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  }

  function handleShare() {
    const url = `${window.location.origin}/profile/${user.id}`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  }

  const roleKey = user.role || "student";
  const roleTone = ROLE_COLORS[roleKey] || "slate";
  const roleLabel = ROLE_LABELS[roleKey] || roleKey;
  const joinedDate = user.created_at
    ? new Date(user.created_at).toLocaleDateString(undefined, {
        month: "short",
        year: "numeric",
      })
    : null;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate/15 bg-white shadow-sm">
      {/* Cover / Wallpaper Banner */}
      <div className="relative h-44 sm:h-56 w-full overflow-hidden bg-gradient-to-r from-navy via-navy/90 to-accent/80">
        {user.cover_image_url ? (
          <img
            src={user.cover_image_url}
            alt="Profile cover"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center opacity-30">
            <span className="text-4xl font-black tracking-widest text-white">GIBIYACHIN</span>
          </div>
        )}

        {/* Cover Controls (Owner Only) */}
        {isOwner && (
          <div className="absolute right-3 top-3 flex items-center gap-2">
            <input
              type="file"
              ref={coverInputRef}
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={handleCoverUpload}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => coverInputRef.current?.click()}
              disabled={uploadingCover}
              className="inline-flex items-center gap-1.5 rounded-lg bg-black/50 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm transition hover:bg-black/70 disabled:opacity-50"
            >
              📷 {uploadingCover ? "Uploading..." : "Change Cover"}
            </button>
            {user.cover_image_url && (
              <button
                type="button"
                onClick={handleRemoveCover}
                disabled={uploadingCover}
                className="inline-flex items-center rounded-lg bg-black/50 px-2.5 py-1.5 text-xs font-medium text-white/90 backdrop-blur-sm transition hover:bg-black/70 disabled:opacity-50"
                title="Remove cover photo"
              >
                ✕
              </button>
            )}
          </div>
        )}
      </div>

      {/* Main Header Info Area */}
      <div className="relative px-6 pb-6 pt-0">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          {/* Avatar & Basic Info */}
          <div className="flex items-end gap-4 -mt-16 sm:-mt-20">
            <div className="relative group">
              <input
                type="file"
                ref={avatarInputRef}
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={handleAvatarUpload}
                className="hidden"
              />
              <div className="relative h-28 w-28 sm:h-32 sm:w-32 overflow-hidden rounded-full border-4 border-white bg-slate/10 shadow-md">
                {user.avatar_url ? (
                  <img
                    src={user.avatar_url}
                    alt={user.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-navy text-3xl sm:text-4xl font-bold text-white">
                    {user.name?.[0]?.toUpperCase() || "U"}
                  </div>
                )}
                {isOwner && (
                  <button
                    type="button"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={uploadingAvatar}
                    className="absolute inset-0 flex items-center justify-center bg-black/40 text-xs font-medium text-white opacity-0 transition group-hover:opacity-100 disabled:opacity-50"
                    title="Change profile picture"
                  >
                    {uploadingAvatar ? "..." : "Change"}
                  </button>
                )}
              </div>
              {/* Campus Verification Badge */}
              {user.verified && (
                <div
                  className="absolute bottom-1 right-1 flex h-7 w-7 items-center justify-center rounded-full bg-ok text-white shadow-md ring-2 ring-white"
                  title="Campus Verified Account"
                >
                  <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
              )}
            </div>

            <div className="mb-2">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl sm:text-2xl font-bold text-navy">{user.name}</h1>
                <Badge tone={roleTone}>{roleLabel}</Badge>
                {user.verified ? (
                  <Badge tone="ok">✓ Verified</Badge>
                ) : (
                  <Badge tone="warn">Unverified</Badge>
                )}
              </div>
              <p className="mt-0.5 text-xs text-slate">
                {user.university_name || "ግቢያችን Community"}
                {joinedDate && ` · Joined ${joinedDate}`}
              </p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            {isOwner ? (
              <>
                <Button onClick={onEditClick} variant="primary">
                  Edit Profile
                </Button>
                <Button
                  as={Link}
                  to={`/profile/${user.id}`}
                  variant="outline"
                  title="View how others see your profile"
                >
                  Public View
                </Button>
                <Button onClick={handleShare} variant="ghost" title="Copy public profile link">
                  {copied ? "✓ Copied!" : "🔗 Share"}
                </Button>
              </>
            ) : (
              <Button onClick={handleShare} variant="outline">
                {copied ? "✓ Copied link!" : "🔗 Share"}
              </Button>
            )}
          </div>
        </div>

        {/* Bio & Academic Details */}
        <div className="mt-5 space-y-3">
          {user.bio ? (
            <p className="max-w-3xl text-sm leading-relaxed text-navy/90">{user.bio}</p>
          ) : (
            isOwner && (
              <p className="text-sm italic text-slate">
                No bio added yet. Click &quot;Edit Profile&quot; to introduce yourself to your campus.
              </p>
            )
          )}

          {/* Metadata Chips */}
          <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-slate">
            {user.department && (
              <span className="inline-flex items-center gap-1 rounded-md bg-slate/5 px-2.5 py-1 font-medium text-navy">
                🏛️ {user.department}
              </span>
            )}
            {user.year && (
              <span className="inline-flex items-center gap-1 rounded-md bg-slate/5 px-2.5 py-1 font-medium text-navy">
                🎓 {user.year}
              </span>
            )}
            {user.email && (
              <span className="inline-flex items-center gap-1 rounded-md bg-slate/5 px-2.5 py-1 font-medium text-slate">
                ✉️ {user.email}
              </span>
            )}
            {user.phone && (
              <span className="inline-flex items-center gap-1 rounded-md bg-slate/5 px-2.5 py-1 font-medium text-slate">
                📞 {user.phone}
              </span>
            )}
            {user.email_verified !== undefined && (
              <span
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium ${
                  user.email_verified ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"
                }`}
              >
                {user.email_verified ? "✓ Email Confirmed" : "⚠️ Email Unconfirmed"}
              </span>
            )}
            {user.suspended && (
              <span className="inline-flex items-center gap-1 rounded-md bg-danger/10 px-2.5 py-1 font-medium text-danger">
                🚫 Account Suspended
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
