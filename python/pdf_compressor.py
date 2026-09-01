#!/usr/bin/env python3
"""PDF compressor CLI.

Two modes:

  clean    - strip unambiguous waste (ICC profiles, duplicate images,
             unused fonts, JS/embedded files/thumbnails/editor metadata,
             off-canvas content) without ever rasterizing anything.

  compress - everything in clean mode, plus a size-target-driven escalation
             through raster recompression, then surgical Form-swap /
             content-stream region promotion (rasterizes only the specific
             heavy vector object/region, sparing all other page text), then
             whole-page rasterization as a last resort.

Always writes a machine-readable JSON report (default <output>.report.json)
so it can be driven from other languages (e.g. R via subprocess) without
scraping stdout.

Exit codes:
  0  success (clean completed, or compress mode hit its target)
  1  compress mode ran to completion but did not reach --target-mb
  2  input file error (missing / not a PDF / encrypted)
  3  verification found unexpected text loss
  4  internal error
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import time

import fitz
import pikepdf

import pdf_engine as engine


def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)


def get_page_text_lengths(path) -> list:
    doc = fitz.open(path)
    lengths = [len(page.get_text()) for page in doc]
    doc.close()
    return lengths


def verify(input_path, output_path) -> dict:
    try:
        in_lengths = get_page_text_lengths(input_path)
        out_lengths = get_page_text_lengths(output_path)
    except Exception as e:
        return {"error": str(e), "page_count_match": False}

    page_count_match = len(in_lengths) == len(out_lengths)
    diffs = []
    flagged = []
    n = min(len(in_lengths), len(out_lengths))
    for i in range(n):
        delta = out_lengths[i] - in_lengths[i]
        if delta != 0:
            diffs.append({"page": i, "input_chars": in_lengths[i],
                          "output_chars": out_lengths[i], "delta": delta})
        if in_lengths[i] > 0 and out_lengths[i] == 0:
            flagged.append(i)

    return {
        "page_count_input": len(in_lengths),
        "page_count_output": len(out_lengths),
        "page_count_match": page_count_match,
        "text_length_input_total": sum(in_lengths),
        "text_length_output_total": sum(out_lengths),
        "text_diff_per_page": diffs,
        "text_loss_flagged_pages": flagged,
    }


def run_clean_pipeline(input_path, output_path, use_ghostscript=True) -> dict:
    """Clean mode: GS reconstruction (optional) + all always-safe pikepdf
    waste removal + off-canvas content removal. Never rasterizes."""
    report = {"clean_actions": {}, "gs_reconstruct_applied": False, "warnings": []}
    work_path = input_path

    if use_ghostscript and engine.ghostscript_available():
        gs_out = output_path + ".gs_tmp.pdf"
        if engine.run_ghostscript_reconstruct(work_path, gs_out):
            if os.path.getsize(gs_out) < os.path.getsize(work_path):
                work_path = gs_out
                report["gs_reconstruct_applied"] = True
            else:
                report["warnings"].append(
                    "Ghostscript reconstruction did not reduce size on this file; skipped")
                os.remove(gs_out)
        else:
            report["warnings"].append("Ghostscript reconstruction failed or unavailable; continuing without it")

    pdf = pikepdf.open(work_path)
    report["clean_actions"] = engine.run_clean(pdf)

    offcanvas_total = 0
    for page in pdf.pages:
        try:
            instructions = engine.get_content_instructions(page.obj)
            brackets = engine.match_q_brackets(instructions)
            walker = engine.ContentStreamWalker()
            walk_result = walker.walk(instructions)
            page_rect = tuple(float(v) for v in page.obj.get("/MediaBox"))
            dead = engine.find_offcanvas_units(instructions, brackets, walk_result, page_rect)
            if dead:
                replacements = [(s, e, None) for s, e in dead]
                engine.splice_page_content(pdf, page, instructions, replacements)
                offcanvas_total += len(dead)
        except Exception as e:
            report["warnings"].append(f"off-canvas removal skipped on a page: {e}")
    report["clean_actions"]["offcanvas_units_removed"] = offcanvas_total

    engine.compact(pdf, output_path)
    pdf.close()

    if work_path != input_path and os.path.exists(work_path):
        os.remove(work_path)

    return report


def apply_form_swap_and_regions(pdf_path, output_path, form_swap_threshold_kb=150,
                                 dpi=200, jpeg_quality=78) -> dict:
    """Open with pikepdf and apply Form-swap to existing heavy Form
    XObjects, plus content-stream region promotion for pages whose bloat
    lives directly in raw content (no isolable Form)."""
    stats = {"forms_swapped": 0, "regions_promoted": 0, "bytes_saved": 0, "warnings": [], "pages_touched": []}
    pdf = pikepdf.open(pdf_path)
    threshold_bytes = form_swap_threshold_kb * 1024

    for page_idx, page in enumerate(pdf.pages):
        # Existing heavy Form XObjects (top-level only)
        res = page.obj.get("/Resources")
        if res is not None and "/XObject" in res:
            for name in list(res.XObject.keys()):
                try:
                    obj = res.XObject[name]
                    if obj.get("/Subtype") != pikepdf.Name.Form:
                        continue
                    if len(obj.read_raw_bytes()) < threshold_bytes:
                        continue
                    result = engine.form_swap(pdf, obj, dpi=dpi, jpeg_quality=jpeg_quality)
                    stats["forms_swapped"] += 1
                    stats["bytes_saved"] += result["raw_bytes_before"] - result["raw_bytes_after"]
                    stats["pages_touched"].append(page_idx)
                except engine.FormSwapSkip:
                    continue
                except Exception as e:
                    stats["warnings"].append(f"form-swap skipped: {e}")

        # Content-stream region promotion
        try:
            instructions = engine.get_content_instructions(page.obj)
            brackets = engine.match_q_brackets(instructions)
            # Defuse the "one shape per q/Q" signature (R's cairo PDF device,
            # among others, emits scatter/network points this way) BEFORE
            # dense-region detection ever sees it - find_dense_regions can't
            # tell "thousands of individually-bracketed points" apart from
            # any other reason a region might be a good promotion candidate,
            # and region promotion has a still-unexplained rendering defect
            # on exactly that pattern. A run this collapses never reaches
            # find_dense_regions as dense in the first place.
            flattened, n_flattened = engine.flatten_redundant_dot_runs(instructions, brackets)
            if n_flattened:
                instructions = flattened
                brackets = engine.match_q_brackets(instructions)
                page.obj.Contents = pdf.make_stream(pikepdf.unparse_content_stream(instructions))
                stats["dot_runs_flattened"] = stats.get("dot_runs_flattened", 0) + n_flattened
            regions = engine.find_dense_regions(instructions, brackets)
        except Exception as e:
            stats["warnings"].append(f"region detection skipped on a page: {e}")
            continue

        replacements = []
        for ctx, start, end in regions:
            try:
                repl, result = engine.promote_region(pdf, page, instructions, start, end,
                                                       dpi=dpi, jpeg_quality=jpeg_quality)
                replacements.append(repl)
                stats["regions_promoted"] += 1
                stats["bytes_saved"] += result["raw_bytes_before"] - result["raw_bytes_after"]
                stats["pages_touched"].append(page_idx)
            except engine.FormSwapSkip:
                continue
            except Exception as e:
                stats["warnings"].append(f"region promotion skipped: {e}")

        if replacements:
            engine.splice_page_content(pdf, page, instructions, replacements)

    engine.compact(pdf, output_path)
    pdf.close()
    stats["pages_touched"] = sorted(set(stats["pages_touched"]))
    return stats


RASTER_LADDER = [
    (1600, 82), (1400, 74), (1200, 68), (1000, 60),
]
WHOLE_PAGE_LADDER = [
    (2, 220, 82), (4, 200, 78), (6, 180, 75), (9, 160, 70), (12, 150, 65),
]


def run_compress_pipeline(input_path, output_path, target_bytes=None, max_iterations=8,
                           use_ghostscript=True, form_swap_threshold_kb=150) -> dict:
    """target_bytes=None means "best quality, no explicit size target": run
    the safe/surgical stages (clean, one gentle raster pass, Form-swap and
    region promotion) and stop there - never fall through to whole-page
    rasterization, which is the only stage that destroys selectable text
    and the only one whose aggressiveness scales with how heavy a page is.
    With a target_bytes set, escalates through the full ladder including
    whole-page rasterization if needed to hit it."""
    tmpdir = tempfile.mkdtemp(prefix="pdf_compressor_")
    stages = []
    iterations = 0
    best_effort = target_bytes is None

    def size_of(p):
        return os.path.getsize(p)

    def hit_target(p):
        return (not best_effort) and size_of(p) <= target_bytes

    def stage(name, fn, work_path, **params):
        nonlocal iterations
        iterations += 1
        before = size_of(work_path)
        next_path = os.path.join(tmpdir, f"stage{iterations}.pdf")
        extra = fn(work_path, next_path)
        after = size_of(next_path)
        stages.append({"stage": name, "params": params, "size_before": before,
                        "size_after": after, **(extra or {})})
        return next_path

    try:
        work_path = os.path.join(tmpdir, "input.pdf")
        shutil.copy(input_path, work_path)

        work_path = stage("clean", lambda i, o: run_clean_pipeline(i, o, use_ghostscript), work_path)
        if hit_target(work_path) or iterations >= max_iterations:
            return _finalize(work_path, output_path, target_bytes, stages, tmpdir)

        # Best-effort mode only takes the single gentlest recompression pass -
        # a target-driven run escalates through the whole ladder if needed.
        raster_rungs = RASTER_LADDER[:1] if best_effort else RASTER_LADDER
        for max_dim, quality in raster_rungs:
            if iterations >= max_iterations:
                break
            work_path = stage(
                "raster_recompress",
                lambda i, o, md=max_dim, q=quality: (
                    {"images_touched": engine.recompress_images(i, o, md, q)}),
                work_path, max_dim=max_dim, quality=quality,
            )
            if hit_target(work_path):
                return _finalize(work_path, output_path, target_bytes, stages, tmpdir)

        if iterations < max_iterations:
            work_path = stage(
                "form_swap_and_regions",
                lambda i, o: apply_form_swap_and_regions(i, o, form_swap_threshold_kb),
                work_path, threshold_kb=form_swap_threshold_kb,
            )
            if hit_target(work_path) or best_effort:
                return _finalize(work_path, output_path, target_bytes, stages, tmpdir)

        for n_pages, dpi, quality in WHOLE_PAGE_LADDER:
            if iterations >= max_iterations:
                break
            ranked = engine.rank_heavy_pages(pikepdf.open(work_path))
            pages = [i for i, _ in ranked[:n_pages]]
            work_path = stage(
                "whole_page_rasterize",
                lambda i, o, p=pages, d=dpi, q=quality: (
                    engine.rasterize_pages(i, o, p, d, q) or {"pages": p}),
                work_path, dpi=dpi, quality=quality, page_count=n_pages,
            )
            if hit_target(work_path):
                return _finalize(work_path, output_path, target_bytes, stages, tmpdir)

        return _finalize(work_path, output_path, target_bytes, stages, tmpdir)
    finally:
        pass  # tmpdir cleanup happens in _finalize


def _finalize(work_path, output_path, target_bytes, stages, tmpdir):
    shutil.copy(work_path, output_path)
    final_size = os.path.getsize(output_path)
    shutil.rmtree(tmpdir, ignore_errors=True)
    return {
        "stages_applied": stages,
        "target_met": True if target_bytes is None else final_size <= target_bytes,
        "final_size_bytes": final_size,
    }


def main():
    parser = argparse.ArgumentParser(description="Compress or clean a PDF.")
    parser.add_argument("input")
    parser.add_argument("-o", "--output", required=True)
    parser.add_argument("--mode", choices=["clean", "compress"], default="clean")
    parser.add_argument("--target-mb", type=float,
                         help="Size target for --mode compress. Omit for best-effort, "
                              "quality-preserving compression: runs clean + one gentle "
                              "image recompression pass + Form-swap/region promotion, "
                              "but never falls through to whole-page rasterization.")
    parser.add_argument("--report")
    parser.add_argument("--max-iterations", type=int, default=8)
    parser.add_argument("--form-swap-threshold-kb", type=int, default=150)
    parser.add_argument("--no-ghostscript", action="store_true")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        eprint(f"Input file not found: {args.input}")
        sys.exit(2)

    try:
        test_pdf = pikepdf.open(args.input)
        test_pdf.close()
    except pikepdf.PasswordError:
        eprint("Input PDF is encrypted/password-protected.")
        sys.exit(2)
    except Exception as e:
        eprint(f"Could not open input as a PDF: {e}")
        sys.exit(2)

    report_path = args.report or (os.path.splitext(args.output)[0] + ".report.json")
    t0 = time.time()
    exit_code = 0

    report = {
        "input_path": args.input, "output_path": args.output, "mode": args.mode,
        "input_size_bytes": os.path.getsize(args.input),
    }

    try:
        if args.mode == "clean":
            result = run_clean_pipeline(args.input, args.output, use_ghostscript=not args.no_ghostscript)
            report.update(result)
            report["success"] = True
        else:
            target_bytes = int(args.target_mb * 1_000_000) if args.target_mb else None
            report["target_mb"] = args.target_mb
            result = run_compress_pipeline(
                args.input, args.output, target_bytes,
                max_iterations=args.max_iterations,
                use_ghostscript=not args.no_ghostscript,
                form_swap_threshold_kb=args.form_swap_threshold_kb,
            )
            report.update(result)
            report["success"] = True
            if not result["target_met"]:
                exit_code = 1
    except Exception as e:
        report["success"] = False
        report["error"] = str(e)
        exit_code = 4
        if args.verbose:
            import traceback
            traceback.print_exc()

    if report.get("success") and os.path.exists(args.output):
        report["output_size_bytes"] = os.path.getsize(args.output)
        if report["input_size_bytes"] > 0:
            report["compression_ratio"] = round(report["input_size_bytes"] / max(1, report["output_size_bytes"]), 2)
        verification = verify(args.input, args.output)
        report["verification"] = verification
        if verification.get("text_loss_flagged_pages") and exit_code == 0:
            expected_loss_pages = set()
            for s in report.get("stages_applied", []):
                if s["stage"] == "whole_page_rasterize":
                    expected_loss_pages.update(s.get("pages", []))
                elif s["stage"] == "form_swap_and_regions":
                    expected_loss_pages.update(s.get("pages_touched", []))
            unexpected = [p for p in verification["text_loss_flagged_pages"] if p not in expected_loss_pages]
            if unexpected:
                report.setdefault("warnings", []).append(
                    f"Unexpected text loss on pages not targeted for whole-page rasterization: {unexpected}")
                exit_code = 3

    report["elapsed_seconds"] = round(time.time() - t0, 2)

    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)

    if args.verbose or exit_code != 0:
        print(json.dumps(report, indent=2))
    else:
        print(f"{args.mode}: {report['input_size_bytes']/1e6:.2f}MB -> "
              f"{report.get('output_size_bytes', 0)/1e6:.2f}MB  "
              f"(report: {report_path})")

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
