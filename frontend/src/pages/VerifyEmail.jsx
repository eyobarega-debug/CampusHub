import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { client, errMsg } from "../api/client";
import { Button, Card, ErrorBanner, Input, PageHeader, SuccessBanner } from "../components/ui";

const PENDING_KEY = "ch_pending_verify_email";
const DEFAULT_TTL_SECONDS = 600; // 10 minutes — matches OTP_TTL_MINUTES
const DEFAULT_COOLDOWN_SECONDS = 60;

function fmt(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export default function VerifyEmail() {
  const navigate = useNavigate();
  const location = useLocation();

  // The email is carried over from the register step. We also stash it in
  // sessionStorage so a page refresh doesn't strand the student.
  const [email, setEmail] = useState(location.state?.email || sessionStorage.getItem(PENDING_KEY) || "");
  const [otp, setOtp] = useState(location.state?.devOtp || "");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [emailManually, setEmailManually] = useState(
    !(location.state?.email || sessionStorage.getItem(PENDING_KEY))
  );

  const [expiresIn, setExpiresIn] = useState(location.state?.expiresInSeconds || DEFAULT_TTL_SECONDS);
  const [cooldown, setCooldown] = useState(location.state?.resendCooldownSeconds || DEFAULT_COOLDOWN_SECONDS);
  const tick = useRef(null);

  useEffect(() => {
    tick.current = setInterval(() => {
      setExpiresIn((v) => (v > 0 ? v - 1 : 0));
      setCooldown((v) => (v > 0 ? v - 1 : 0));
    }, 1000);
    return () => clearInterval(tick.current);
  }, []);

  async function onVerify(e) {
    e.preventDefault();
    setError("");
    setSuccess("");
    setVerifying(true);
    try {
      const { data } = await client.post("/auth/verify-email", { email, otp });
      sessionStorage.removeItem(PENDING_KEY);
      setSuccess(data.message + " Redirecting to log in…");
      setTimeout(() => navigate("/login", { replace: true, state: { flash: "Email verified — you can now log in." } }), 1600);
    } catch (err) {
      setError(errMsg(err, "Could not verify the code"));
      setOtp("");
    } finally {
      setVerifying(false);
    }
  }

  async function onResend() {
    setError("");
    setSuccess("");
    setResending(true);
    try {
      const { data } = await client.post("/auth/verify-email/resend", { email });
      setSuccess(data.message);
      setCooldown(data.resendCooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS);
      setExpiresIn(data.expiresInSeconds ?? DEFAULT_TTL_SECONDS);
      // Outside production the backend returns the code so you can complete
      // the flow without a real SMTP server.
      if (data.devOtp) setOtp(data.devOtp);
    } catch (err) {
      setError(errMsg(err, "Could not resend the code"));
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm py-12">
      <PageHeader title="Verify your email" subtitle="Enter the 6-digit code sent to your email." />
      <Card className="p-6">
        <form onSubmit={onVerify} className="space-y-4">
          <ErrorBanner message={error} />
          <SuccessBanner message={success} />

          {emailManually ? (
            <Input
              label="Email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@aastu.edu.et"
            />
          ) : (
            <p className="text-sm text-slate">
              We sent a code to <span className="font-medium text-navy">{email}</span>.{" "}
              <button
                type="button"
                onClick={() => setEmailManually(true)}
                className="underline"
              >
                Not you?
              </button>
            </p>
          )}

          <Input
            label="Verification code"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="123456"
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="text-center text-2xl tracking-[0.5em]"
          />

          <p className="text-center text-xs text-slate">
            {expiresIn > 0 ? (
              <>Code expires in <span className="font-medium text-navy">{fmt(expiresIn)}</span></>
            ) : (
              <span className="font-medium text-danger">This code has expired — request a new one.</span>
            )}
          </p>

          <Button type="submit" className="w-full" disabled={verifying || email.length === 0 || otp.length !== 6}>
            {verifying ? "Verifying..." : "Verify OTP"}
          </Button>
        </form>

        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-slate">Didn't get the code?</span>
          <Button variant="ghost" onClick={onResend} disabled={resending || cooldown > 0}>
            {resending ? "Sending..." : cooldown > 0 ? `Resend in ${fmt(cooldown)}` : "Resend OTP"}
          </Button>
        </div>

        <p className="mt-4 text-center text-sm text-slate">
          <Link to="/register" className="underline">Back to sign up</Link>
        </p>
      </Card>
    </div>
  );
}
