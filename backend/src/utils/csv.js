// Deliberately dependency-free — the exports needed here are simple enough
// that pulling in a CSV library isn't worth it. Handles the one escaping
// rule that actually matters: quote any field containing a comma, quote,
// or newline, and double up internal quotes.
function toCsv(rows, columns) {
  const esc = (val) => {
    if (val === null || val === undefined) return "";
    const s = String(val);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => esc(c.label)).join(",");
  const body = rows.map((row) => columns.map((c) => esc(typeof c.value === "function" ? c.value(row) : row[c.value])).join(",")).join("\n");
  return `${header}\n${body}`;
}

module.exports = { toCsv };
