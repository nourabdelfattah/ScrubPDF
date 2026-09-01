// Regenerates ../index.html from shell.html + engine.js + the vendored
// pdf-lib/pdf.js bundles. Run this (from anywhere) after editing engine.js
// or shell.html, and commit the resulting index.html alongside your change:
//
//   node web/build.js
//
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const vendor = path.join(dir, "vendor");
const shell = fs.readFileSync(path.join(dir, "shell.html"), "utf8");
const pdfLib = fs.readFileSync(path.join(vendor, "pdf-lib.min.js"), "utf8");
const pdfJs = fs.readFileSync(path.join(vendor, "pdf.min.js"), "utf8");
const pdfWorkerB64 = fs.readFileSync(path.join(vendor, "pdf.worker.min.js")).toString("base64");
const engine = fs.readFileSync(path.join(dir, "engine.js"), "utf8");

let out = shell
  .replace("/*__PDFLIB_JS__*/", () => pdfLib)
  .replace("/*__PDFJS_JS__*/", () => pdfJs)
  .replace("__PDFWORKER_B64__", () => pdfWorkerB64)
  .replace("/*__ENGINE_JS__*/", () => engine);

// Written to the repo root (not web/) so GitHub Pages serves it at "/"
// automatically with zero configuration.
const outPath = path.join(dir, "..", "index.html");
fs.writeFileSync(outPath, out);
console.log("built:", outPath, (out.length / 1e6).toFixed(2), "MB");
