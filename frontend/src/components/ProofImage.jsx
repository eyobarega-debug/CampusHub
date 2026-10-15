import { useEffect, useState } from "react";
import { client } from "../api/client";
import { Spinner } from "./ui";

// Payment screenshots are private (they show account details), so they can't be a plain
// <img src>: the browser would not send the login token. Fetch as a blob instead.
export default function ProofImage({ paymentId, version }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url;
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    client
      .get(`/payments/${paymentId}/proof/image`, { responseType: "blob" })
      .then(({ data }) => {
        if (cancelled) return;
        url = URL.createObjectURL(data);
        setSrc(url);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [paymentId, version]);

  if (failed) return <p className="text-sm text-danger">Could not load the screenshot.</p>;
  if (!src) return <Spinner />;
  return (
    <a href={src} target="_blank" rel="noreferrer" title="Open full size">
      <img src={src} alt="Payment screenshot" className="max-h-80 rounded-lg border border-slate/20 object-contain" />
    </a>
  );
}