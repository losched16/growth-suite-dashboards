// Browser-only: turns a menu PDF into one image so the Menus page can
// show, print and cache it like any other picture (PDFs embedded in a
// page don't scroll on iPads and print inconsistently). Runs when the
// editor picks the file, so the server only ever stores an image.
//
// Pages are stacked top to bottom into a single image. Menus are one
// page in practice; MAX_PAGES keeps a stray 40-page PDF from locking up
// the browser.

export const MENU_PDF_MAX_PAGES = 3;
const TARGET_WIDTH = 1600;            // px — sharp on a full-width screen and when printed
const MAX_TOTAL_PIXELS = 14_000_000;  // stay under iOS Safari's canvas limit
const MAX_BYTES = 12 * 1024 * 1024;   // upload cap is 15 MB; leave headroom

export interface ConvertedMenu {
  blob: Blob;
  filename: string;
  pagesInPdf: number;
  pagesUsed: number;
}

export async function menuPdfToImage(file: File): Promise<ConvertedMenu> {
  // Legacy build: same renderer, transpiled for browsers a few years back
  // (school iPads and old laptops are the norm).
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();

  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'PasswordException') throw new Error('This PDF is password-protected. Save an unprotected copy and try again.');
    throw new Error('That PDF could not be read. Try exporting it again, or upload a photo/screenshot of the menu instead.');
  }

  const pagesInPdf = doc.numPages;
  const pagesUsed = Math.min(pagesInPdf, MENU_PDF_MAX_PAGES);
  const pages: HTMLCanvasElement[] = [];
  let totalPixels = 0;
  for (let i = 1; i <= pagesUsed; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    let scale = TARGET_WIDTH / base.width;
    // Shrink if the stacked result would be too big for the browser.
    const wouldBe = totalPixels + Math.ceil(base.width * scale) * Math.ceil(base.height * scale);
    if (wouldBe > MAX_TOTAL_PIXELS) scale *= Math.sqrt(MAX_TOTAL_PIXELS / wouldBe);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser could not prepare the PDF. Try a different browser, or upload a photo of the menu.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, viewport }).promise;
    totalPixels += canvas.width * canvas.height;
    pages.push(canvas);
  }
  await task.destroy();

  const width = Math.max(...pages.map((p) => p.width));
  const height = pages.reduce((n, p) => n + p.height, 0);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const octx = out.getContext('2d')!;
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, width, height);
  let y = 0;
  for (const p of pages) {
    octx.drawImage(p, Math.round((width - p.width) / 2), y);
    y += p.height;
  }

  const toBlob = (type: string, q?: number) =>
    new Promise<Blob | null>((resolve) => out.toBlob(resolve, type, q));
  let blob = await toBlob('image/png');
  let ext = 'png';
  if (!blob || blob.size > MAX_BYTES) {
    blob = await toBlob('image/jpeg', 0.9);
    ext = 'jpg';
  }
  if (!blob) throw new Error('This browser could not prepare the PDF. Try a different browser, or upload a photo of the menu.');

  const base = file.name.replace(/\.pdf$/i, '').replace(/[^a-z0-9._ -]/gi, '_') || 'menu';
  return { blob, filename: `${base}.${ext}`, pagesInPdf, pagesUsed };
}
