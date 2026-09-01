# Thin wrapper around pdf_compressor.py for use from R packages.
# Requires: processx, jsonlite (R side); pikepdf/pymupdf/Pillow (Python side,
# see requirements.txt).
#
# Usage:
#   source("compress_pdf.R")
#   result <- compress_pdf("in.pdf", "out.pdf", mode = "compress", target_mb = 10)
#   result$success       # TRUE/FALSE
#   result$report$output_size_bytes
#   result$report$verification$text_loss_flagged_pages

# Known install location, used as a last-resort fallback below. Override by
# passing `script=` explicitly, or by setting options(pdf_compressor_dir=...).
.pdf_compressor_default_dir <- "~/Desktop/Claude Tools/PDF compressor"

# Find compress_pdf.R's own directory, whether it was source()'d
# interactively, run via Rscript, or neither (falls back to a default).
.pdf_compressor_find_dir <- function() {
  # Rscript / littler invocation
  cmd_args <- commandArgs(trailingOnly = FALSE)
  file_arg <- grep("^--file=", cmd_args, value = TRUE)
  if (length(file_arg) > 0) {
    return(dirname(normalizePath(sub("^--file=", "", file_arg[1]), mustWork = FALSE)))
  }
  # source()'d: some frame on the current call stack has an `ofile` set
  for (i in rev(seq_len(sys.nframe()))) {
    ofile <- tryCatch(get("ofile", envir = sys.frame(i), inherits = FALSE),
                       error = function(e) NULL)
    if (!is.null(ofile) && nzchar(ofile)) {
      return(dirname(normalizePath(ofile, mustWork = FALSE)))
    }
  }
  if (file.exists("pdf_compressor.py")) return(getwd())
  path.expand(getOption("pdf_compressor_dir", .pdf_compressor_default_dir))
}

.pdf_compressor_dir <- .pdf_compressor_find_dir()

compress_pdf <- function(input, output, mode = c("clean", "compress"),
                          target_mb = NULL, report = NULL,
                          python = "python3", script = NULL,
                          extra_args = character(0)) {
  mode <- match.arg(mode)
  input <- path.expand(input)
  output <- path.expand(output)
  if (is.null(script)) {
    script <- file.path(.pdf_compressor_dir, "pdf_compressor.py")
  }
  if (!file.exists(script)) {
    stop("Could not find pdf_compressor.py (looked at '", script, "'). ",
         "Pass script=\"/path/to/pdf_compressor.py\" explicitly.")
  }
  # target_mb is optional for mode = "compress": omit it for best-effort,
  # quality-preserving compression (never rasterizes whole pages).
  if (is.null(report)) {
    report <- paste0(tools::file_path_sans_ext(output), ".report.json")
  } else {
    report <- path.expand(report)
  }

  args <- c(script, input, "-o", output, "--mode", mode, "--report", report)
  if (mode == "compress") {
    args <- c(args, "--target-mb", as.character(target_mb))
  }
  args <- c(args, extra_args)

  res <- processx::run(python, args, error_on_status = FALSE)

  report_data <- NULL
  if (file.exists(report)) {
    report_data <- tryCatch(jsonlite::fromJSON(report, simplifyVector = TRUE),
                             error = function(e) NULL)
  }

  list(
    exit_code = res$status,
    stdout = res$stdout,
    stderr = res$stderr,
    report = report_data,
    success = !is.null(report_data) && isTRUE(report_data$success)
  )
}
