const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function sparkline(values: number[], width = 16): string {
  if (values.length === 0) return "";
  const slice = values.length > width ? values.slice(-width) : values;
  let min = Infinity, max = -Infinity;
  for (const v of slice) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max === min) return BLOCKS[3].repeat(slice.length);
  const span = max - min;
  return slice
    .map((v) => BLOCKS[Math.min(7, Math.floor(((v - min) / span) * 7.999))])
    .join("");
}

export function deltaArrow(values: number[]): string {
  if (values.length < 2) return "";
  const a = values[values.length - 1];
  const b = values[values.length - 2];
  if (a > b) return `↑${a - b}`;
  if (a < b) return `↓${b - a}`;
  return "·";
}

// ── SVG sparkline (Phase 7) ──────────────────────────────────────────────
// Returns an SVG markup string with line + area + tail dot. Used by the
// Mission Control Trends panel when a richer rendering than Unicode blocks
// is preferred.

interface SparkOpts { width?: number; height?: number; color?: string; }

export function sparklineSvg(values: number[], opts: SparkOpts = {}): string {
  const w = opts.width ?? 160;
  const h = opts.height ?? 24;
  const color = opts.color ?? "var(--aos-cyan)";
  if (values.length === 0) {
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"></svg>`;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values.map((v, i) => {
    const x = values.length > 1 ? i * step : w;
    const y = h - ((v - min) / range) * h;
    return { x, y };
  });
  const line = "M " + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ");
  const area = line + ` L ${pts[pts.length - 1].x.toFixed(1)},${h} L ${pts[0].x.toFixed(1)},${h} Z`;
  const tail = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    ${values.length > 1 ? `<path d="${area}" fill="${color}" opacity="0.18"/>` : ""}
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.2"/>
    <circle cx="${tail.x.toFixed(1)}" cy="${tail.y.toFixed(1)}" r="2.2" fill="${color}"/>
  </svg>`;
}
