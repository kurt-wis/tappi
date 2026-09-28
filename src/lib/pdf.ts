import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export type PdfColumn = {
  header: string;
  /** Relative width; columns share the usable page width in proportion. */
  width: number;
  align?: "left" | "right";
};

export type PdfTable = {
  title: string;
  subtitle?: string;
  columns: PdfColumn[];
  rows: string[][];
};

// A4 landscape, in points.
const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const MARGIN = 36;
const FONT_SIZE = 8;
const HEADER_SIZE = 8;
const ROW_HEIGHT = 14;
const CELL_PADDING = 3;

/**
 * The standard 14 fonts only encode WinAnsi (Latin-1-ish). Accented Latin
 * names like "Peña" survive; anything else (CJK, emoji) becomes "?" rather
 * than throwing mid-export.
 */
export function toWinAnsi(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const ellipsis = "...";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (font.widthOfTextAtSize(text.slice(0, mid) + ellipsis, size) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low) + ellipsis;
}

/** Plain paginated table: title + subtitle on page 1, repeated column headers, page numbers. */
export async function renderTablePdf(table: PdfTable): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(toWinAnsi(table.title));
  doc.setCreator("Tappi");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const usable = PAGE_WIDTH - MARGIN * 2;
  const totalWeight = table.columns.reduce((sum, column) => sum + column.width, 0);
  const widths = table.columns.map((column) => (column.width / totalWeight) * usable);

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;

  const drawRow = (cells: string[], rowFont: PDFFont, size: number, shade: boolean) => {
    if (shade) {
      page.drawRectangle({
        x: MARGIN, y: y - ROW_HEIGHT + 4, width: usable, height: ROW_HEIGHT,
        color: rgb(0.95, 0.95, 0.95),
      });
    }
    let x = MARGIN;
    table.columns.forEach((column, index) => {
      const maxWidth = widths[index] - CELL_PADDING * 2;
      const text = fit(toWinAnsi(cells[index] ?? ""), rowFont, size, maxWidth);
      const textWidth = rowFont.widthOfTextAtSize(text, size);
      const textX = column.align === "right" ? x + widths[index] - CELL_PADDING - textWidth : x + CELL_PADDING;
      page.drawText(text, { x: textX, y: y - ROW_HEIGHT + 8, size, font: rowFont, color: rgb(0.1, 0.1, 0.1) });
      x += widths[index];
    });
    y -= ROW_HEIGHT;
  };

  const newPage = () => {
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pages.push(page);
    y = PAGE_HEIGHT - MARGIN;
    if (pages.length === 1) {
      page.drawText(fit(toWinAnsi(table.title), bold, 14, usable), { x: MARGIN, y: y - 14, size: 14, font: bold });
      y -= 22;
      if (table.subtitle) {
        page.drawText(fit(toWinAnsi(table.subtitle), font, 8, usable), {
          x: MARGIN, y: y - 8, size: 8, font, color: rgb(0.35, 0.35, 0.35),
        });
        y -= 16;
      }
    }
    drawRow(table.columns.map((column) => column.header), bold, HEADER_SIZE, false);
    page.drawLine({
      start: { x: MARGIN, y: y + 3 }, end: { x: MARGIN + usable, y: y + 3 },
      thickness: 0.75, color: rgb(0.4, 0.4, 0.4),
    });
  };

  newPage();
  if (table.rows.length === 0) {
    page.drawText("No rows match these filters.", { x: MARGIN + CELL_PADDING, y: y - ROW_HEIGHT + 8, size: FONT_SIZE, font });
  }
  table.rows.forEach((row, index) => {
    if (y - ROW_HEIGHT < MARGIN + 12) newPage();
    drawRow(row, font, FONT_SIZE, index % 2 === 1);
  });

  pages.forEach((p, index) => {
    const label = `Page ${index + 1} of ${pages.length}`;
    p.drawText(label, {
      x: PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(label, 7), y: MARGIN - 14, size: 7, font,
      color: rgb(0.45, 0.45, 0.45),
    });
  });

  return doc.save();
}
