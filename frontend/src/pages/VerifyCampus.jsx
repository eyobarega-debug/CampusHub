import { useEffect, useState } from "react";
import { client } from "../api/client";
import { errMsg } from "../context/AuthContext";
import { Badge, Button, Card, ErrorBanner, PageHeader, Select, Spinner, SuccessBanner, TextArea } from "../components/ui";
import VerificationDocument from "../components/VerificationDocument";

const DOC_TYPES = [
  { value: "student_id", label: "Student ID" },
  { value: "university_id_card", label: "University ID card" },
  { value: "proof_of_enrollment", label: "Proof of enrollment / enrollment letter" },
  { value: "other", label: "Other approved proof" },
];

const STATUS_TONE = { pending: "warn", approved: "ok", rejected: "danger" };

function fmt(date) {
  return date ? new Date(date).toLocaleString() : "";
}

export default function VerifyCampus() {
  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [form, setForm] = useState({ documentType: "student_id", studentNote: "" });
  const [file, setFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setError("");
    try {
      const [{ data: s }, { data: h }] = await Promise.all([
        client.get("/verifications/me/status"),
        client.get("/verifications/me/requests"),
      ]);
      setStatus(s);
      setHistory(h.requests);
    } catch (err) {
      setError(errMsg(err, "Could not load verification status"));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setSuccess("");
    if (!file) {
      setError("Attach your verification document (image or PDF).");
      return;
    }
    setSubmitting(true);
    try {
      const data = new FormData();
      data.append("documentType", form.documentType);
      if (form.studentNote) data.append("studentNote", form.studentNote);
      data.append("document", file);
      await client.post("/verifications/submit", data);
      setSuccess("Your verification request has been submitted and is under review.");
      setFile(null);
      setForm({ documentType: "student_id", studentNote: "" });
      const fileInput = document.getElementById("verification-document-input");
      if (fileInput) fileInput.value = "";
      await load();
    } catch (err) {
      setError(errMsg(err, "Could not submit verification request"));
    } finally {
      setSubmitting(false);
    }
  }

  if (!status) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const canSubmit = !status.verified && !status.hasPending;

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="Verify Campus Account" subtitle="Prove your campus membership when your university email can't verify you automatically." />
      <div className="space-y-6">
        <ErrorBanner message={error} />
        <SuccessBanner message={success} />

        <Card className="p-6">
          {status.verified ? (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Badge tone="ok">campus verified</Badge>
                <Badge tone="navy">
                  {status.verificationMethod === "domain" ? "verified by university email" : "verified by document review"}
                </Badge>
              </div>
              <p className="text-sm text-slate">
                Your account is already campus verified — no further action is needed.
              </p>
            </div>
          ) : status.hasPending ? (
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge tone="warn">pending</Badge>
                <span className="text-sm font-medium text-navy">Your verification is under review</span>
              </div>
              <p className="text-sm text-slate">
                Submitted {fmt(status.pendingRequest?.createdAt)}
                {status.pendingRequest?.documentType
                  ? ` · ${DOC_TYPES.find((d) => d.value === status.pendingRequest.documentType)?.label || status.pendingRequest.documentType}`
                  : ""}
                .
              </p>
              {status.pendingRequest?.hasDocument && (
                <div className="mt-3">
                  <p className="mb-1 text-sm font-medium text-navy">Your submitted document</p>
                  <VerificationDocument url={`/verifications/me/requests/${status.pendingRequest.id}/document`} />
                </div>
              )}
              <p className="mt-3 text-xs text-slate">
                A university administrator will review it. You'll get a notification once it's approved or rejected.
              </p>
            </div>
          ) : (
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Badge tone="warn">unverified</Badge>
                <span className="text-sm font-medium text-navy">Your university email couldn't verify you automatically</span>
              </div>
              {status.latestRequest?.status === "rejected" && (
                <div className="mb-4 rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger">
                  <p className="font-medium">Your last request was rejected</p>
                  <p className="mt-1">Reason: {status.latestRequest.rejectionReason || "No reason provided"}</p>
                  <p className="mt-1 text-xs">You can fix the issue and submit a new request below.</p>
                </div>
              )}
              <form onSubmit={submit} className="space-y-4">
                <Select
                  label="Verification document type"
                  value={form.documentType}
                  onChange={(e) => setForm({ ...form, documentType: e.target.value })}
                >
                  {DOC_TYPES.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </Select>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-navy">Document upload</span>
                  <input
                    id="verification-document-input"
                    type="file"
                    required
                    accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                    className="block w-full text-sm text-slate file:mr-3 file:rounded-lg file:border-0 file:bg-navy/10 file:px-4 file:py-2 file:text-sm file:font-medium file:text-navy"
                  />
                  <span className="mt-1 block text-xs text-slate">
                    JPEG, PNG, WEBP, GIF or PDF — up to 10MB. Your file is stored privately.
                  </span>
                  {file && <span className="mt-1 block text-xs text-navy">Selected: {file.name}</span>}
                </label>
                <TextArea
                  label="Note to the reviewer (optional)"
                  placeholder="Anything the administrator should know"
                  rows={3}
                  value={form.studentNote}
                  onChange={(e) => setForm({ ...form, studentNote: e.target.value })}
                />
                <Button type="submit" className="w-full" disabled={submitting || !canSubmit}>
                  {submitting ? "Submitting..." : "Submit verification request"}
                </Button>
              </form>
            </div>
          )}
        </Card>

        {history && history.length > 0 && (
          <Card className="p-6">
            <h2 className="mb-3 font-semibold text-navy">Request history</h2>
            <div className="space-y-2">
              {history.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate/15 px-3 py-2">
                  <div>
                    <p className="text-sm text-navy">
                      {DOC_TYPES.find((d) => d.value === r.documentType)?.label || r.documentType}
                    </p>
                    <p className="text-xs text-slate">Submitted {fmt(r.createdAt)}{r.reviewedAt ? ` · reviewed ${fmt(r.reviewedAt)}` : ""}</p>
                    {r.status === "rejected" && r.rejectionReason && (
                      <p className="text-xs text-danger">Reason: {r.rejectionReason}</p>
                    )}
                  </div>
                  <Badge tone={STATUS_TONE[r.status] || "slate"}>{r.status}</Badge>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
