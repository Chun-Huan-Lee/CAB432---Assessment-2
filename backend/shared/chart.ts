/**
 * Renders a small SVG bar chart of triaged issues. The MCP server returns it
 * as MCP image content and the chat agent forwards it to the browser as an
 * ACP image block (the "receive images in chat" requirement).
 */
export interface ChartBar {
  label: string;
  value: number;
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[char]!);
}

const COLOURS = ["#2563eb", "#7c3aed", "#db2777", "#ea580c", "#16a34a", "#0891b2", "#ca8a04", "#4b5563"];

export function barChartSvg(title: string, groups: Array<{ heading: string; bars: ChartBar[] }>): string {
  const width = 760;
  const rowHeight = 30;
  const labelWidth = 170;
  const chartWidth = width - labelWidth - 80;
  const rows = groups.reduce((total, group) => total + group.bars.length + 1, 0);
  const height = 70 + rows * rowHeight + 20;
  const max = Math.max(1, ...groups.flatMap((group) => group.bars.map((bar) => bar.value)));
  let y = 70;
  let colour = 0;
  const parts: string[] = [];
  for (const group of groups) {
    parts.push(`<text x="24" y="${y + 18}" font-size="15" font-weight="700" fill="#0f172a">${escapeXml(group.heading)}</text>`);
    y += rowHeight;
    for (const bar of group.bars) {
      const barWidth = Math.max(2, Math.round((bar.value / max) * chartWidth));
      parts.push(
        `<text x="${labelWidth}" y="${y + 18}" font-size="13" text-anchor="end" fill="#334155">${escapeXml(bar.label)}</text>`,
        `<rect x="${labelWidth + 10}" y="${y + 5}" width="${barWidth}" height="18" rx="4" fill="${COLOURS[colour % COLOURS.length]}"/>`,
        `<text x="${labelWidth + 16 + barWidth}" y="${y + 19}" font-size="13" fill="#0f172a">${bar.value}</text>`,
      );
      colour += 1;
      y += rowHeight;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" rx="16" fill="#f8fafc"/>` +
    `<text x="24" y="42" font-size="20" font-weight="700" font-family="sans-serif" fill="#0f172a">${escapeXml(title)}</text>` +
    `<g font-family="sans-serif">${parts.join("")}</g></svg>`;
}
