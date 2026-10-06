/**
 * Conversions of GLM-OCR outputs for export: the HTML tables it emits to CSV / Markdown and
 * its LaTeX formulas to MathML. Table parsing uses the browser's DOMParser (the app is client-only);
 * the grid logic is pure so it can be exercised without a DOM.
 */

import katex from 'katex';

export interface TableCell {
  text: string;
  rowspan: number;
  colspan: number;
  header: boolean;
}

export interface TableRow {
  cells: TableCell[];
}

/** Rows in rendering order (thead rows first, as `HTMLTableElement.rows` yields them). */
export interface TableModel {
  rows: TableRow[];
}

/**
 * Expands row/col spans into a rectangular grid of strings: every row has the same number of
 * columns and a spanned cell repeats its text in every slot it covers.
 */
export function tableGrid(table: TableModel): string[][] {
  const grid: string[][] = table.rows.map(() => []);
  const taken: boolean[][] = table.rows.map(() => []);
  table.rows.forEach((row, r) => {
    let c = 0;
    for (const cell of row.cells) {
      while (taken[r][c]) c++;
      // rowspan="0" means "to the end of the section"; spans never reach past the table.
      const rows = Math.min(cell.rowspan > 0 ? cell.rowspan : grid.length, grid.length - r);
      const cols = Math.max(1, cell.colspan);
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
          grid[r + i][c + j] = cell.text;
          taken[r + i][c + j] = true;
        }
      }
      c += cols;
    }
  });
  let width = 0;
  for (const row of grid) width = Math.max(width, row.length);
  for (const row of grid) for (let c = 0; c < width; c++) row[c] ??= '';
  return grid;
}

function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV (comma, CRLF record terminators, quotes doubled, fields quoted only when needed). */
export function gridToCsv(grid: string[][]): string {
  let out = '';
  for (const row of grid) out += `${row.map(csvField).join(',')}\r\n`;
  return out;
}

function markdownCell(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
}

/** GitHub-flavoured Markdown table; the first grid row is the header. */
export function gridToMarkdown(grid: string[][]): string {
  if (grid.length === 0 || grid[0].length === 0) return '';
  const lines = grid.map(row => `| ${row.map(markdownCell).join(' | ')} |`);
  lines.splice(1, 0, `| ${grid[0].map(() => '---').join(' | ')} |`);
  return `${lines.join('\n')}\n`;
}

function parseCell(cell: HTMLTableCellElement): TableCell {
  return {
    text: (cell.textContent ?? '').replace(/\s+/g, ' ').trim(),
    rowspan: cell.rowSpan,
    colspan: cell.colSpan,
    header: cell.tagName === 'TH',
  };
}

/** The first `<table>` in `html` as a row/cell model, or null when there is none. */
export function parseTable(html: string): TableModel | null {
  const table = new DOMParser().parseFromString(html, 'text/html').querySelector('table');
  if (!table) return null;
  // `table.rows` lists only this table's rows (nested tables excluded), thead first regardless of source order.
  return {rows: Array.from(table.rows, row => ({cells: Array.from(row.cells, parseCell)}))};
}

/**
 * CSV (RFC 4180) of the first `<table>` in `html`; rowspan/colspan are expanded so every row has the
 * same number of cells (spanned cells repeat the value). Empty string when there is no table.
 */
export function tableToCsv(html: string): string {
  const table = parseTable(html);
  return table ? gridToCsv(tableGrid(table)) : '';
}

/**
 * GitHub-flavoured Markdown table of the first `<table>`: header = first `<thead>` row, else the first
 * row; pipes escaped as `\|`, newlines in cells collapsed to spaces; spans expanded as for CSV.
 * Empty string when there is no table.
 */
export function tableToMarkdown(html: string): string {
  const table = parseTable(html);
  return table ? gridToMarkdown(tableGrid(table)) : '';
}

const MATH_ELEMENT = /<math[\s>][\s\S]*?<\/math>/;

/**
 * MathML for a LaTeX formula via KaTeX (display mode, errors never thrown): the `<math>…</math>`
 * element only. Unparseable input yields a `<merror>` carrying the source, so the export is still MathML.
 */
export function formulaToMathML(tex: string): string {
  const html = katex.renderToString(tex, {output: 'mathml', displayMode: true, throwOnError: false});
  const match = MATH_ELEMENT.exec(html);
  if (match) return match[0];
  const source = tex.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><merror><mtext>${source}</mtext></merror></math>`;
}
