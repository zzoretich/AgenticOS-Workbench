// donut.ts — SVG ring chart, ported from dashboards/dashboard.js. Used by the
// Disk panel in Mission Control. Returns inline SVG markup (string) so the
// caller can drop it into innerHTML — keeps render() pure-DOM mutation cheap.

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

interface Segment { name: string; bytes: number; }

export function donutSvg(segments: Segment[], total: number, size = 140): string {
  if (!total || segments.length === 0) return "";
  const cx = size / 2, cy = size / 2;
  const radius = size * 0.38;
  const thickness = size * 0.16;
  const inner = radius - thickness;
  let start = -Math.PI / 2; // 12 o'clock
  const arcs: string[] = [];
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
    const color = DONUT_COLORS[i % DONUT_COLORS.length];
    arcs.push(
      `<path d="M${sx.toFixed(2)},${sy.toFixed(2)} A${radius},${radius} 0 ${largeArc} 1 ${ex.toFixed(2)},${ey.toFixed(2)} L${sxi.toFixed(2)},${syi.toFixed(2)} A${inner},${inner} 0 ${largeArc} 0 ${exi.toFixed(2)},${eyi.toFixed(2)} Z" fill="${color}" opacity="0.85"/>`
    );
    start = end;
  }
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">${arcs.join("")}</svg>`;
}
