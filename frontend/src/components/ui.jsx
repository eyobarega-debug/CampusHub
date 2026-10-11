export function Button({ as: As = "button", variant = "primary", className = "", ...props }) {
  const base = "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed";
  const variants = {
    primary: "bg-navy text-white hover:bg-navy-dark",
    accent: "bg-accent text-white hover:bg-accent-dark",
    outline: "border border-slate/40 text-slate hover:bg-slate/10",
    danger: "bg-danger text-white hover:brightness-90",
    ghost: "text-slate hover:bg-slate/10",
  };
  return <As className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

export function Card({ className = "", children }) {
  return <div className={`rounded-xl border border-slate/15 bg-white shadow-sm ${className}`}>{children}</div>;
}

export function Badge({ tone = "slate", children }) {
  const tones = {
    slate: "bg-slate/10 text-slate",
    ok: "bg-ok/10 text-ok",
    warn: "bg-warn/10 text-warn",
    danger: "bg-danger/10 text-danger",
    navy: "bg-navy/10 text-navy",
    accent: "bg-accent/10 text-accent-dark",
  };
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function Input({ label, error, className = "", ...props }) {
  return (
    <label className="block">
      {label && <span className="mb-1 block text-sm font-medium text-navy">{label}</span>}
      <input
        className={`w-full rounded-lg border border-slate/25 px-3 py-2 text-sm outline-none focus:border-navy focus:ring-1 focus:ring-navy ${className}`}
        {...props}
      />
      {error && <span className="mt-1 block text-xs text-danger">{error}</span>}
    </label>
  );
}

export function TextArea({ label, className = "", ...props }) {
  return (
    <label className="block">
      {label && <span className="mb-1 block text-sm font-medium text-navy">{label}</span>}
      <textarea
        className={`w-full rounded-lg border border-slate/25 px-3 py-2 text-sm outline-none focus:border-navy focus:ring-1 focus:ring-navy ${className}`}
        {...props}
      />
    </label>
  );
}

export function Select({ label, className = "", children, ...props }) {
  return (
    <label className="block">
      {label && <span className="mb-1 block text-sm font-medium text-navy">{label}</span>}
      <select
        className={`w-full rounded-lg border border-slate/25 bg-white px-3 py-2 text-sm outline-none focus:border-navy focus:ring-1 focus:ring-navy ${className}`}
        {...props}
      >
        {children}
      </select>
    </label>
  );
}

export function Spinner({ className = "" }) {
  return (
    <div className={`h-5 w-5 animate-spin rounded-full border-2 border-slate/30 border-t-navy ${className}`} />
  );
}

export function EmptyState({ title, subtitle, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate/25 py-16 text-center">
      <p className="font-medium text-navy">{title}</p>
      {subtitle && <p className="max-w-sm text-sm text-slate">{subtitle}</p>}
      {action}
    </div>
  );
}

export function ErrorBanner({ message }) {
  if (!message) return null;
  return <div className="rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger">{message}</div>;
}

export function SuccessBanner({ message }) {
  if (!message) return null;
  return <div className="rounded-lg bg-ok/10 px-4 py-3 text-sm text-ok">{message}</div>;
}

export function PageHeader({ title, subtitle, action }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-navy">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
