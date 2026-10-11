import { useState } from "react";
import { client } from "../api/client";

export default function ImageUploader({ value = [], onChange, max = 4 }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  async function handleFiles(fileList) {
    setError("");
    const files = Array.from(fileList).slice(0, max - value.length);
    if (files.length === 0) return;
    setUploading(true);
    try {
      const uploaded = [];
      for (const file of files) {
        const form = new FormData();
        form.append("file", file);
        const { data } = await client.post("/uploads", form);
        uploaded.push(data.url);
      }
      onChange([...value, ...uploaded]);
    } catch (err) {
      setError(err?.response?.data?.error?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function remove(url) {
    onChange(value.filter((u) => u !== url));
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {value.map((url) => (
          <div key={url} className="relative h-20 w-20 overflow-hidden rounded-lg border border-slate/20">
            <img src={url} alt="" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => remove(url)}
              className="absolute right-0.5 top-0.5 rounded-full bg-black/60 px-1.5 text-xs text-white"
            >
              ✕
            </button>
          </div>
        ))}
        {value.length < max && (
          <label className="flex h-20 w-20 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-slate/30 text-xs text-slate hover:border-navy hover:text-navy">
            {uploading ? "..." : "+ Add"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              className="hidden"
              disabled={uploading}
              onChange={(e) => handleFiles(e.target.files)}
            />
          </label>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      <p className="mt-1 text-xs text-slate">Up to {max} images, 5MB each.</p>
    </div>
  );
}
