/// <reference types="vite/client" />

// pdfjs-dist ships the worker as a self-contained webpack bundle without a .d.ts.
// We import it as a side effect only (to register globalThis.pdfjsWorker); no
// exports are used, so an empty module declaration is sufficient.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
