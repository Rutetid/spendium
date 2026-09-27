import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as pdfjsWorkerModule from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

// Turbopack statically rewrites `createRequire(...).resolve("pkg")` into a
// module id (a number), breaking path.dirname. Obtain createRequire through
// process.getBuiltinModule so .resolve stays a real filesystem lookup — the
// same trick pdf.js itself uses.
const nodeModule = (
  process as unknown as { getBuiltinModule(id: string): typeof import('node:module') }
).getBuiltinModule('node:module');
const require_ = nodeModule.createRequire(import.meta.url);

// pdfjs-dist v6 has no "disable worker" flag. In Node it always runs an
// in-process fake worker whose handler is resolved from
// `globalThis.pdfjsWorker.WorkerMessageHandler` FIRST, and only otherwise via
// `import(workerSrc)` — a dynamic import Turbopack intercepts and breaks.
// Register the handler explicitly (covering ESM-namespace and interop shapes)
// and leave workerSrc empty so no worker file is ever requested.
const workerHandler =
  (pdfjsWorkerModule as { WorkerMessageHandler?: unknown }).WorkerMessageHandler ??
  (pdfjsWorkerModule as { default?: { WorkerMessageHandler?: unknown } }).default
    ?.WorkerMessageHandler;

if (process.env.NODE_ENV !== 'production') {
  console.log('[ingest] WorkerMessageHandler type:', typeof workerHandler);
}

if (typeof workerHandler !== 'function') {
  throw new Error(
    '[ingest] pdf.worker.mjs did not expose WorkerMessageHandler — PDF extraction cannot run.',
  );
}

(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = {
  WorkerMessageHandler: workerHandler,
};
pdfjs.GlobalWorkerOptions.workerSrc = '';

// On Node, font/cmap data is read from disk with fs.readFile, so these must be
// plain filesystem paths (not file:// URLs) with a trailing separator.
const PDFJS_ROOT = path.dirname(require_.resolve('pdfjs-dist/package.json'));
const STANDARD_FONT_DATA_URL = `${path.join(PDFJS_ROOT, 'standard_fonts')}${path.sep}`;
const CMAP_URL = `${path.join(PDFJS_ROOT, 'cmaps')}${path.sep}`;

/**
 * Fraction of page-1 height (measured from the top) whose text is dropped.
 * Bank statements put name/address/IFSC/branch in this region. Tunable —
 * calibrate against real statement formats.
 */
export const PAGE1_HEADER_STRIP_FRACTION = 0.35;

/** Max baseline-Y distance (PDF points) for items to count as the same line. */
export const LINE_Y_TOLERANCE_PT = 3;

/** Below this many non-whitespace chars, treat the PDF as image-only. */
export const MIN_SANITIZED_CHARS = 50;

/** Lifetime of rawText on a statements row. */
export const RAW_TEXT_TTL_DAYS = 14;

export class IngestionError extends Error {}

interface PositionedItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

export interface SanitizedExtraction {
  text: string;
  totalPages: number;
  pageCharCounts: number[];
  /** Items dropped from the page-1 header region (for the dev log). */
  stripped: { itemCount: number; sample: string };
}

function groupIntoLines(items: PositionedItem[]): string[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { anchorY: number; items: PositionedItem[] }[] = [];

  for (const item of sorted) {
    const current = lines[lines.length - 1];
    if (current && Math.abs(item.y - current.anchorY) <= LINE_Y_TOLERANCE_PT) {
      current.items.push(item);
    } else {
      lines.push({ anchorY: item.y, items: [item] });
    }
  }

  return lines.map(({ items: lineItems }) => {
    const byX = [...lineItems].sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd: number | null = null;
    for (const item of byX) {
      if (prevEnd !== null) {
        const gap = item.x - prevEnd;
        text += gap > 1 ? ' ' : '';
      }
      text += item.str;
      prevEnd = item.x + item.width;
    }
    return text.replace(/ {2,}/g, ' ').trimEnd();
  });
}

function toIngestionError(error: unknown): IngestionError {
  const name = error instanceof Error ? error.name : '';
  if (name === 'PasswordException') {
    return new IngestionError(
      'This PDF is password-protected — unlock it and try again.',
    );
  }
  return new IngestionError(
    "Couldn't read this PDF — the file may be corrupt or not a real PDF.",
  );
}

export async function extractAndSanitize(
  data: Uint8Array,
): Promise<SanitizedExtraction> {
  const loadingTask = pdfjs.getDocument({
    data,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
  });

  try {
    let pdf;
    try {
      pdf = await loadingTask.promise;
    } catch (error) {
      console.error('[ingest] getDocument failed:', error);
      throw toIngestionError(error);
    }

    const totalPages = pdf.numPages;
    const pageCharCounts: number[] = [];
    const pageLines: string[][] = [];
    const strippedItems: PositionedItem[] = [];

    try {
      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const { height } = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();

        let items: PositionedItem[] = [];
        for (const item of content.items) {
          if ('str' in item && typeof item.str === 'string') {
            items.push({
              str: item.str,
              x: item.transform[4],
              y: item.transform[5],
              width: item.width,
            });
          }
        }
        items = items.filter((item) => item.str.trim().length > 0);

        if (pageNum === 1 && PAGE1_HEADER_STRIP_FRACTION > 0) {
          const thresholdY = height * (1 - PAGE1_HEADER_STRIP_FRACTION);
          items = items.filter((item) => {
            if (item.y >= thresholdY) {
              strippedItems.push(item);
              return false;
            }
            return true;
          });
        }

        const lines = groupIntoLines(items);
        pageLines.push(lines);
        pageCharCounts.push(lines.join('').replace(/\s+/g, '').length);
      }
    } catch (error) {
      if (error instanceof IngestionError) throw error;
      console.error('[ingest] page processing failed:', error);
      throw toIngestionError(error);
    }

    const text = pageLines.map((lines) => lines.join('\n')).join('\n\n');

    if (text.replace(/\s+/g, '').length < MIN_SANITIZED_CHARS) {
      throw new IngestionError(
        "This looks like a scanned document — image-based statements aren't supported yet.",
      );
    }

    strippedItems.sort((a, b) => b.y - a.y || a.x - b.x);
    const sample = strippedItems
      .map((item) => item.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      text,
      totalPages,
      pageCharCounts,
      stripped: { itemCount: strippedItems.length, sample },
    };
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}
