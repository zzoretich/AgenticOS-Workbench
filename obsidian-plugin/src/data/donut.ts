// donut.ts — SVG ring chart for the SYSTEM drawer's DISK panel. donutArcs() is pure
// (testable); donutElement() builds real SVG nodes with createElementNS — no markup strings are ever assigned.
import { TOKENS } from "../ui/tokens";

export const DONUT_COLORS = [
  TOKENS.chart1, // cyan
  TOKENS.chart2, // pink
  TOKENS.chart3, // amber
  TOKENS.chart4, // green
  TOKENS.chart5, // violet
  TOKENS.chart6, // orange
  TOKENS.chart7, // slate (for "other")
];

const SVG_NS = "http://www.w3.org/2000/svg";

export interface Segment { name: string; bytes: number; }
export interface DonutArc { d: string; fill: string; opacity: string; }

export function donutArcs(segments: Segment[], total: number, size = 140): DonutArc[] {
  if (!total || segments.length === 0) return [];
  const cx = size / 2, cy = size / 2;
  const radius = size * 0.38;
  const thickness = size * 0.16;
  const inner = radius - thickness;
  let start = -Math.PI / 2; // 12 o'clock
  const arcs: DonutArc[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.bytes <= 0) continue;
    const angle = (seg.bytes / total) * Math.PI * 2;
    const end = start + angle;
    const largeArc = angle > Math.PI ? 1 : 0;
    const sx = cx + Math.cos(start) * radius;
    const sy = cy + Math.sin(start) * radius;
    const ex = cx + Math.cos(end) * radius;
    const ey = cy + Math.sin(end) * radius;
    const sxi = cx + Math.cos(end) * inner;
    const syi = cy + Math.sin(end) * inner;
    const exi = cx + Math.cos(start) * inner;
    const eyi = cy + Math.sin(start) * inner;
    arcs.push({
      d: `M${sx.toFixed(2)},${sy.toFixed(2)} A${radius},${radius} 0 ${largeArc} 1 ${ex.toFixed(2)},${ey.toFixed(2)} L${sxi.toFixed(2)},${syi.toFixed(2)} A${inner},${inner} 0 ${largeArc} 0 ${exi.toFixed(2)},${eyi.toFixed(2)} Z`,
      fill: DONUT_COLORS[i % DONUT_COLORS.length],
      opacity: "0.85",
    });
    start = end;
  }
  return arcs;
}

export function donutElement(segments: Segment[], total: number, size = 140): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  for (const a of donutArcs(segments, total, size)) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", a.d);
    p.setAttribute("fill", a.fill);
    p.setAttribute("opacity", a.opacity);
    svg.appendChild(p);
  }
  return svg;
}
