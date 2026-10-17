import { useState, useRef } from "react";
import { Button, Card, ErrorBanner, Input, TextArea } from "../ui";
import { client, errMsg } from "../../api/client";
import ProfileHeader from "./ProfileHeader";

export default function EditProfileModal({ user, isOpen, onClose, onSaved }) {
  const [activeTab, setActiveTab] = useState("form"); // 'form' | 'preview'
  const [form, setForm] = useState({
    name: user?.name || "",
    phone: user?.phone || "",
    department: user?.department || "",
    year: user?.year || "",
    bio: user?.bio || "",
    avatarUrl: user?.avatar_url || "",
    coverImageUrl: user?.cover_image_url || "",
  });

  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [error, setError] = useState("");

  const avatarInputRef = useRef(null);
  const coverInputRef = useRef(null);

  if (!isOpen || !user) return null;

  async function handleAvatarUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError("Avatar image must be under 5MB");
      return;
    }
    setUploadingAvatar(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const { data } = await client.post("/uploads", formData);
      setForm((prev) => ({ ...prev, avatarUrl: data.url }));
    } catch (err) {
      setError(errMsg(err, "Failed to upload avatar image"));
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function handleCoverUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError("Cover image must be under 5MB");
      return;
    }
    setUploadingCover(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const { data } = await client.post("/uploads", formData);
      setForm((prev) => ({ ...prev, coverImageUrl: data.url }));
    } catch (err) {
      setError(errMsg(err, "Failed to upload cover image"));
    } finally {
      setUploadingCover(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await client.patch("/users/me", {
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        department: form.department.trim() || null,
        year: form.year.trim() || null,
        bio: form.bio.trim() || null,
        avatarUrl: form.avatarUrl || null,
        coverImageUrl: form.coverImageUrl || null,
      });
      if (onSaved) await onSaved();
      onClose();
    } catch (err) {
      setError(errMsg(err, "Failed to save profile changes"));
    } finally {
      setSaving(false);
    }
  }

  // Preview user object merging changes
  const previewUser = {
    ...user,
    name: form.name || user.name,
    phone: form.phone,
    department: form.department,
    year: form.year,
    bio: form.bio,
    avatar_url: form.avatarUrl,
    cover_image_url: form.coverImageUrl,
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <Card className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden bg-white shadow-2xl">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-slate/15 px-6 py-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-navy">Edit Profile</h2>
            <div className="flex rounded-lg bg-slate/10 p-0.5">
              <button
                type="button"
                onClick={() => setActiveTab("form")}
                className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                  activeTab === "form" ? "bg-white text-navy shadow-sm" : "text-slate hover:text-navy"
                }`}
              >
                Edit Details
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("preview")}
                className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                  activeTab === "preview" ? "bg-white text-navy shadow-sm" : "text-slate hover:text-navy"
                }`}
              >
                Live Preview
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate transition hover:bg-slate/10 hover:text-navy"
          >
            ✕
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6">
          <ErrorBanner message={error} />

          {activeTab === "preview" ? (
            <div className="space-y-4">
              <p className="text-xs text-slate">
                This is a live preview of how your updated profile header will appear across ግቢያችን:
              </p>
              <ProfileHeader user={previewUser} isOwner={false} />
            </div>
          ) : (
            <form onSubmit={handleSubmit} id="edit-profile-form" className="space-y-4">
              {/* Avatar & Cover Uploaders */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {/* Profile Picture */}
                <div>
                  <label className="block text-sm font-medium text-navy mb-1">
                    Profile Picture / Avatar
                  </label>
                  <div className="flex items-center gap-3">
                    <div className="h-16 w-16 overflow-hidden rounded-full border-2 border-slate/20 bg-slate/10">
                      {form.avatarUrl ? (
                        <img src={form.avatarUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-navy text-white font-bold">
                          {form.name?.[0]?.toUpperCase() || "U"}
                        </div>
                      )}
                    </div>
                    <div className="space-y-1">
                      <input
                        type="file"
                        ref={avatarInputRef}
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        onChange={handleAvatarUpload}
                        className="hidden"
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="px-2.5 py-1 text-xs"
                          onClick={() => avatarInputRef.current?.click()}
                          disabled={uploadingAvatar}
                        >
                          {uploadingAvatar ? "Uploading..." : "Upload Photo"}
                        </Button>
                        {form.avatarUrl && (
                          <button
                            type="button"
                            onClick={() => setForm((prev) => ({ ...prev, avatarUrl: "" }))}
                            className="text-xs text-danger hover:underline"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      <p className="text-[10px] text-slate">PNG, JPG, WEBP up to 5MB</p>
                    </div>
                  </div>
                </div>

                {/* Cover / Wallpaper */}
                <div>
                  <label className="block text-sm font-medium text-navy mb-1">
                    Profile Cover / Wallpaper
                  </label>
                  <div className="flex items-center gap-3">
                    <div className="h-16 w-24 overflow-hidden rounded-lg border-2 border-slate/20 bg-slate/10">
                      {form.coverImageUrl ? (
                        <img src={form.coverImageUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-gradient-to-r from-navy to-accent/60 text-[10px] text-white">
                          Default Cover
                        </div>
                      )}
                    </div>
                    <div className="space-y-1">
                      <input
                        type="file"
                        ref={coverInputRef}
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        onChange={handleCoverUpload}
                        className="hidden"
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="px-2.5 py-1 text-xs"
                          onClick={() => coverInputRef.current?.click()}
                          disabled={uploadingCover}
                        >
                          {uploadingCover ? "Uploading..." : "Upload Cover"}
                        </Button>
                        {form.coverImageUrl && (
                          <button
                            type="button"
                            onClick={() => setForm((prev) => ({ ...prev, coverImageUrl: "" }))}
                            className="text-xs text-danger hover:underline"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      <p className="text-[10px] text-slate">Wide banner, max 5MB</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Basic Fields */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  label="Full Name *"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                />
                <Input
                  label="Phone Number"
                  placeholder="+251 9..."
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </div>

              {/* Academic Fields */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  label="Department / Major"
                  placeholder="e.g. Software Engineering"
                  value={form.department}
                  onChange={(e) => setForm({ ...form, department: e.target.value })}
                />
                <Input
                  label="Year / Academic Standing"
                  placeholder="e.g. 3rd Year / Senior"
                  value={form.year}
                  onChange={(e) => setForm({ ...form, year: e.target.value })}
                />
              </div>

              {/* Bio Field with character counter */}
              <div>
                <TextArea
                  label="Bio / About"
                  rows={3}
                  placeholder="Share a few words about what you study, sell, organize, or your campus interests..."
                  value={form.bio}
                  onChange={(e) => {
                    if (e.target.value.length <= 1000) {
                      setForm({ ...form, bio: e.target.value });
                    }
                  }}
                />
                <p className="mt-1 text-right text-[11px] text-slate">
                  {form.bio.length} / 1000 characters
                </p>
              </div>

              {/* University Affiliation (Read-Only) */}
              <div className="rounded-lg bg-slate/5 p-3 text-xs text-slate">
                <span className="font-semibold text-navy">University: </span>
                {user.university_name || "ግቢያችን"} ·{" "}
                <span className="italic">
                  University affiliation, role, and verification badges cannot be modified directly.
                </span>
              </div>
            </form>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-slate/15 bg-slate/5 px-6 py-3">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="edit-profile-form"
            disabled={saving || uploadingAvatar || uploadingCover}
          >
            {saving ? "Saving Changes..." : "Save Profile"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
