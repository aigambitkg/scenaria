/**
 * Reading numbers people type (E3b-2), shared with the dashboard — no imports.
 *
 * Tokens are whole numbers: plain digits, or digits in groups of three with a separator in either language
 * ("150.000", "150,000", "150 000", "150_000"), or with k / m ("128k" = 128,000). Anything else ("200.00", "1.5") is
 * no number — a typo must not become another, plausible value. Percentages take at most one decimal, with a comma or
 * a point ("47,5" / "47.5"), and may end in "%". An empty or unreadable field is null, never 0: an emptied field must
 * not silently become "no buffer".
 */
export function parseTokens(text: string): number | null {
  const s = String(text ?? "").trim();
  const k = /^(\d+(?:[.,]\d+)?)\s*([kKmM])$/.exec(s);
  if (k) {
    const n = Number(k[1].replace(",", ".")) * (k[2].toLowerCase() === "k" ? 1000 : 1_000_000);
    return Number.isInteger(n) ? n : null;
  }
  if (/^\d{1,12}$/.test(s)) return Number(s);
  if (/^\d{1,3}(?:[.,'’ _  ]\d{3})+$/.test(s)) return Number(s.replace(/\D/g, ""));
  return null;
}

export function parsePercent(text: string): number | null {
  const s = String(text ?? "").trim().replace(/\s*%$/, "").replace(",", ".");
  return /^\d{1,3}(?:\.\d)?$/.test(s) ? Number(s) : null;
}
