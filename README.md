# ScrubPDF

In-browser PDF compression that doesn't destroy your figures. Cleans
invisible ghost content other tools miss, keeps text/axes crisp.

Most PDF compressors just turn every page into a blurry image. ScrubPDF
doesn't. It keeps your text sharp and your charts as real, crisp vector
graphics, even for figures with dense scatter plots or heatmaps.

**[Try it now](https://nourabdelfattah.github.io/ScrubPDF/)**. Nothing to
install. Your file is never uploaded anywhere.

## Two ways to use it

**In your browser.** Open the link above. Drag in a PDF. Download the
result. That's it. Everything happens on your own computer, nothing is
sent anywhere.

**From the command line (Python).** For batch jobs or scripts. Same
cleanup logic, plus one extra compression step that only works outside a
browser.

## Repo layout

```
index.html              the browser tool - open this, or use the Pages link
web/
  engine.js              the JS compression engine (source of truth for index.html)
  shell.html              UI template index.html is generated from
  build.js                regenerates ../index.html from shell.html + engine.js + vendor/
  vendor/                 vendored pdf-lib and pdf.js builds
python/
  pdf_engine.py            the Python compression engine
  pdf_compressor.py        CLI entry point
  requirements.txt
r/
  compress_pdf.R           thin subprocess wrapper around python/pdf_compressor.py
```

After editing `web/engine.js` or `web/shell.html`, regenerate the built tool
and commit the result alongside your change:

```bash
node web/build.js
```

## Install (Python version)

```bash
pip install -r python/requirements.txt \
  --trusted-host pypi.org --trusted-host files.pythonhosted.org --trusted-host pypi.python.org
```

(The `--trusted-host` flags work around a local SSL cert issue on some
machines; drop them if `pip install -r python/requirements.txt` works
without.)

Ghostscript (`gs`) is used if it's on `PATH`, but it's optional.

## Usage

```bash
# Clean mode: strip waste, never rasterize anything
python3 python/pdf_compressor.py input.pdf -o output.pdf --mode clean

# Compress mode with a target size: shrinks as far as needed to hit it,
# rasterizing the heaviest pages only if nothing else gets it small enough
python3 python/pdf_compressor.py input.pdf -o output.pdf --mode compress --target-mb 10

# Compress mode with no target: gets it smaller without picking a number,
# and never rasterizes a whole page
python3 python/pdf_compressor.py input.pdf -o output.pdf --mode compress
```

Always writes a JSON report (default `<output>.report.json`, or `--report path.json`).

### Flags

| Flag | Meaning |
|---|---|
| `-o, --output` | required, output PDF path |
| `--mode {clean,compress}` | required |
| `--target-mb` | required for `compress` mode |
| `--report PATH` | JSON report path (default `<output>.report.json`) |
| `--max-iterations` | cap on escalation stages in compress mode (default 8) |
| `--form-swap-threshold-kb` | minimum size of an embedded object to attempt swapping (default 150) |
| `--no-ghostscript` | skip the optional Ghostscript pre-pass |
| `-v, --verbose` | print the full JSON report to stdout; also prints tracebacks on internal errors |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | ran fully but didn't reach `--target-mb` (not a crash, check the report) |
| 2 | input file error (missing / not a PDF / encrypted) |
| 3 | text loss detected that wasn't expected |
| 4 | internal error (see `--verbose` for a traceback) |

### JSON report

Key fields: `input_size_bytes`, `output_size_bytes`, `compression_ratio`,
`target_met`, `stages_applied`, `clean_actions`, `verification` (flags any
page whose text unexpectedly disappeared).

## How it works

**Cleaning** never changes how a page looks. It just removes waste:
- Color profiles and duplicate images
- Unused fonts, embedded scripts, attachments, editor metadata
- Invisible leftover content: shapes or old text positioned off the page,
  or clipped so they can never be seen. Editing tools leave this behind
  all the time. It's real content sitting in the file, but it never
  renders, so removing it changes nothing you can see.

**Compressing** (only if you give it a size target) also:
- Recompresses images at a lower quality
- Replaces the busiest parts of a page with a single flattened image, but
  only the parts that are actually heavy
- As a last resort, flattens a whole page to an image, only if nothing
  else gets it small enough, and only on the pages that need it

Pages that are already light are left alone. Pages with a lot of clutter
get compressed more. That's intentional: it means only what actually needs
shrinking gets touched.

## Known limitations

- Can't tell apart a scatter plot's dots from body text laid out the same
  way, in rare cases. It's built to be cautious about this.
- Can't detect content that's hidden because something else is drawn on
  top of it (only content that's off the page or clipped away).
- Doesn't crop images that are mostly hidden behind a crop box.
- The heaviest compression setting can occasionally sweep a small bit of
  on-figure text into an image along with it. Captions and other page text
  are never affected.
- Doesn't export to EPS/PostScript.

## R integration

```r
source("r/compress_pdf.R")
result <- compress_pdf("in.pdf", "out.pdf", mode = "compress", target_mb = 10)

# Check if the process ran smoothly
result$success                                  

# See the final weight of your pristine file
result$report$output_size_bytes

# Confirm your text is perfectly preserved
result$report$verification$text_loss_flagged_pages
```

Requires the R packages `processx` and `jsonlite`.

## License

MIT - see [LICENSE](LICENSE). The vendored [pdf-lib](https://github.com/Hopding/pdf-lib)
(MIT) and [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0) builds in
`web/vendor/` retain their own upstream licenses.
