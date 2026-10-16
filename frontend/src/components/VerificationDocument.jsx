import { useEffect, useState } from "react";
import { client } from "../api/client";
import { Spinner } from "./ui";

// Verification documents are private (student IDs, enrollment letters), so
// they can't be a plain <img src>: the browser would not send the login
// token. Fetch as a blob instead (same pattern as ProofImage).
export default function VerificationDocument({ url }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [mime, setMime] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let created = null;
    let cancelled = false;
    setBlobUrl(null);
    setFailed(false);
    client
      .get(url, { responseType: "blob" })
      .then(({ data }) => {
        if (cancelled) return;
        created = URL.createObjectURL(data);
        setMime(data.type || "");
        setBlobUrl(created);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [url]);

  if (failed) return <p className="text-sm text-danger">Could not load the document.</p>;
  if (!blobUrl) return <Spinner />;
  if (mime.startsWith("image/")) {
    return (
      <a href={blobUrl} target="_blank" rel="noreferrer" title="Open full size">
        <img src={blobUrl} alt="Verification document" className="max-h-80 rounded-lg border border-slate/20 object-contain" />
      </a>
    );
  }
  return (
    <a href={blobUrl} target="_blank" rel="noreferrer" className="text-sm font-medium text-navy underline">
      Open document{mime === "application/pdf" ? " (PDF)" : ""}
    </a>
  );
}
