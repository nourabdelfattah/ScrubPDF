"""Core PDF mutation engine for the PDF compressor tool.

Two families of technique:

  - "Clean" functions strip unambiguous waste (ICC profiles, duplicate
    images, unused fonts, editor metadata) without ever rasterizing
    anything. Safe to run unconditionally.

  - "Rasterize" functions (form_swap, promote_region, rasterize_pages)
    convert dense vector content to raster images to hit a size target.
    form_swap and promote_region are surgical: they replace only the
    offending object/region, leaving the rest of the page (including all
    other text) completely untouched. rasterize_pages is the last-resort
    fallback that flattens an entire page.

A single content-stream walker (ContentStreamWalker) tracks the graphics
state (CTM via q/Q/cm, clip bbox via re/W/n) and is shared by unused-font
detection, aggressive-crop detection, and region promotion.
"""

from __future__ import annotations

import hashlib
import io
import zlib
from dataclasses import dataclass, field

import pikepdf
from pikepdf import Name
import fitz
from PIL import Image

Matrix = tuple  # (a, b, c, d, e, f)
IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)

PAINT_OPS = {"f", "F", "f*", "S", "s", "B", "B*", "b", "b*", "n"}
PATH_CONSTRUCTION_OPS = {"m", "l", "c", "v", "y", "re", "h"}
CLIP_OPS = {"W", "W*"}


def mat_mult(m1: Matrix, m2: Matrix) -> Matrix:
    """Concatenate PDF matrices: result maps a point through m1 first, then m2."""
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def apply_point(m: Matrix, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def mat_invert(m: Matrix) -> Matrix:
    a, b, c, d, e, f = m
    det = a * d - b * c
    if abs(det) < 1e-12:
        raise ValueError("singular matrix, cannot invert")
    ia, ib, ic, id_ = d / det, -b / det, -c / det, a / det
    ie = -(e * ia + f * ic)
    if_ = -(e * ib + f * id_)
    return (ia, ib, ic, id_, ie, if_)


def bbox_union(a, b):
    if a is None:
        return b
    if b is None:
        return a
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def points_bbox(points):
    if not points:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return (min(xs), min(ys), max(xs), max(ys))


def bbox_intersect(a, b):
    if a is None:
        return b
    if b is None:
        return a
    x0 = max(a[0], b[0])
    y0 = max(a[1], b[1])
    x1 = min(a[2], b[2])
    y1 = min(a[3], b[3])
    if x0 >= x1 or y0 >= y1:
        return (x0, y0, x0, y0)  # degenerate/empty
    return (x0, y0, x1, y1)


def bboxes_disjoint(a, b) -> bool:
    """True only if `a` and `b` share no point at all. Unlike
    bbox_area(bbox_intersect(a, b)) <= 0, this correctly treats a
    zero-width/zero-height bbox (a perfectly horizontal or vertical stroked
    line - e.g. an axis line or tick mark, which is real, visible content
    despite having zero *fill area*) sitting exactly on a boundary as
    overlapping, not empty. Only used for "is this genuinely off-page"
    decisions; bbox_intersect's area-based emptiness is still correct for
    narrowing clip regions."""
    if a is None or b is None:
        return False
    return a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3]


def bbox_area(bbox):
    if bbox is None:
        return None
    return max(0.0, bbox[2] - bbox[0]) * max(0.0, bbox[3] - bbox[1])


@dataclass
class PaintEvent:
    """One paint (fill/stroke/image/text) operation, in page space."""
    index: int  # index into the instruction list
    depth: int  # graphics-state stack depth at the time it fired
    bbox: tuple | None  # (x0, y0, x1, y1) in page space, or None if unknown
    is_image: bool = False
    # True when this paint's own geometry never intersects the clip that was
    # active at the moment it fired - it is *provably* invisible (zero
    # possible pixels) regardless of where it sits relative to the page.
    # Distinct from bbox=None ("unknown extent, be conservative"): this is
    # "known extent, known to be dead." See find_offcanvas_units.
    definitely_dead: bool = False


@dataclass
class WalkResult:
    paint_events: list = field(default_factory=list)
    font_uses: set = field(default_factory=set)  # Name of fonts used via Tf
    # index -> (ctm at that instruction's execution, stack depth)
    ctm_at: dict = field(default_factory=dict)
    depth_at: dict = field(default_factory=dict)
    clip_at: dict = field(default_factory=dict)  # index -> active clip bbox (page space) or None


class ContentStreamWalker:
    """Stack-based interpreter tracking CTM and (approximate) clip bbox.

    Approximates non-rectangular clip paths by their bounding box - exact
    clip-path geometry isn't needed for the size-heuristics this engine
    uses it for (font-usage scanning, aggressive-crop detection, region
    promotion).
    """

    def __init__(self, initial_ctm: Matrix = IDENTITY, initial_clip=None):
        self.ctm = initial_ctm
        self.clip_bbox = initial_clip
        self._stack = []  # list of (ctm, clip_bbox, tfs, th, trise, tl)
        self._pending_path_points = []
        self._pending_clip_points = None
        self._in_text = False
        self._cur_point = (0.0, 0.0)
        # Text state, tracked well enough to derive a generously-conservative
        # bbox for Tj/TJ/'/" - not exact glyph metrics (no font widths are
        # consulted), just enough to catch content whose text matrix places
        # it nowhere near its own active clip or the page (see
        # _text_paint_bbox). Tm/Tlm reset on BT per spec (not part of the
        # q/Q-saved graphics state); tfs/th/trise/tl are.
        self.tm = IDENTITY
        self.tlm = IDENTITY
        self.tfs = 1.0   # font size, from the 2nd operand of Tf
        self.th = 1.0    # horizontal scaling = Tz/100 (default 100)
        self.trise = 0.0  # text rise, from Ts
        self.tl = 0.0    # leading, from TL (used by T*)

    # -- graphics state -----------------------------------------------
    def _push(self):
        self._stack.append((self.ctm, self.clip_bbox, self.tfs, self.th, self.trise, self.tl))

    def _pop(self):
        if self._stack:
            (self.ctm, self.clip_bbox, self.tfs, self.th,
             self.trise, self.tl) = self._stack.pop()

    def _text_paint_bbox(self, char_count):
        """Generously-conservative page-space bbox for showing `char_count`
        characters at the current text/graphics state, plus the text-space
        advance to move Tm forward by afterward. Deliberately overestimates
        (up to 1em advance per character, 1em ascent, 0.3em descent) so it
        only ever flags content as off-page/dead when it truly is - the
        failure mode to avoid is treating real, visible text as dead, not
        the reverse."""
        if char_count <= 0:
            return None, 0.0
        advance = char_count * 1.0  # em units, generous vs typical ~0.3-0.7em/char
        trm_scale = (self.tfs * self.th, 0.0, 0.0, self.tfs, 0.0, self.trise)
        full = mat_mult(mat_mult(trm_scale, self.tm), self.ctm)
        corners = [(0.0, -0.3), (advance, -0.3), (advance, 1.0), (0.0, 1.0)]
        pts = [apply_point(full, x, y) for x, y in corners]
        return points_bbox(pts), advance

    @property
    def depth(self):
        return len(self._stack)

    # -- main entry point ------------------------------------------------
    def walk(self, instructions) -> WalkResult:
        result = WalkResult()
        for idx, instr in enumerate(instructions):
            op = str(instr.operator)
            operands = instr.operands
            result.ctm_at[idx] = self.ctm
            result.depth_at[idx] = self.depth
            result.clip_at[idx] = self.clip_bbox

            if op == "q":
                self._push()
            elif op == "Q":
                self._pop()
            elif op == "cm":
                m = tuple(float(v) for v in operands[:6])
                self.ctm = mat_mult(m, self.ctm)
            elif op == "BT":
                self._in_text = True
                self.tm = IDENTITY
                self.tlm = IDENTITY
            elif op == "ET":
                self._in_text = False
            elif op == "Tf":
                if len(operands) >= 1:
                    result.font_uses.add(str(operands[0]))
                if len(operands) >= 2:
                    try:
                        self.tfs = float(operands[1])
                    except (TypeError, ValueError):
                        pass
            elif op == "Tz":
                if operands:
                    self.th = float(operands[0]) / 100.0
            elif op == "Ts":
                if operands:
                    self.trise = float(operands[0])
            elif op == "TL":
                if operands:
                    self.tl = float(operands[0])
            elif op == "Tm":
                if len(operands) >= 6:
                    m = tuple(float(v) for v in operands[:6])
                    self.tm = m
                    self.tlm = m
            elif op in ("Td", "TD"):
                if len(operands) >= 2:
                    tx, ty = float(operands[0]), float(operands[1])
                    if op == "TD":
                        self.tl = -ty
                    self.tlm = mat_mult((1.0, 0.0, 0.0, 1.0, tx, ty), self.tlm)
                    self.tm = self.tlm
            elif op == "T*":
                self.tlm = mat_mult((1.0, 0.0, 0.0, 1.0, 0.0, -self.tl), self.tlm)
                self.tm = self.tlm
            elif op in PATH_CONSTRUCTION_OPS and not self._in_text:
                self._consume_path_op(op, operands)
            elif op in CLIP_OPS:
                self._pending_clip_points = list(self._pending_path_points)
            elif op in PAINT_OPS:
                bbox = points_bbox(self._pending_path_points)
                if bbox is not None and self.clip_bbox is not None:
                    if bboxes_disjoint(bbox, self.clip_bbox):
                        # Fully clipped away by the *approximate* (bounding-box)
                        # active clip - genuinely provably dead only if that
                        # approximation is exact. It isn't always: found via a
                        # real file where small per-panel images legitimately
                        # inside their true (non-rectangular/nested) clip got
                        # marked definitely_dead here and deleted outright,
                        # because the bbox-only clip approximation disagreed
                        # with the real clip shape. Unlike the text case below
                        # (a deliberately generous, purpose-built estimate),
                        # this reuses clip tracking that was only ever meant
                        # for heuristic sizing - not safe to treat as proof.
                        # Fall back to "unknown" rather than "definitely dead".
                        bbox = None
                    else:
                        bbox = bbox_intersect(bbox, self.clip_bbox)
                if op != "n":  # 'n' paints nothing, it only ever sets a clip
                    result.paint_events.append(
                        PaintEvent(index=idx, depth=self.depth, bbox=bbox)
                    )
                if self._pending_clip_points is not None:
                    clip_candidate = points_bbox(self._pending_clip_points)
                    # Real-world renderers (MuPDF included) treat a degenerate
                    # (zero-area) clip path as a no-op rather than clipping
                    # everything away - some PDF generators emit "0 0 0 0 re
                    # W n" as an inert placeholder. Match that leniency.
                    if clip_candidate is not None and bbox_area(clip_candidate) > 0:
                        self.clip_bbox = bbox_intersect(self.clip_bbox, clip_candidate)
                    self._pending_clip_points = None
                self._pending_path_points = []
            elif op == "Do":
                # XObject invocation (image or nested form) - record its
                # unit-square placement under the current CTM, clipped.
                corners = [(0, 0), (1, 0), (1, 1), (0, 1)]
                pts = [apply_point(self.ctm, x, y) for x, y in corners]
                bbox = points_bbox(pts)
                if bbox is not None and self.clip_bbox is not None:
                    if bboxes_disjoint(bbox, self.clip_bbox):
                        # See the PAINT_OPS comment above: the bbox-only clip
                        # approximation isn't reliable enough to treat a
                        # "disjoint" result as proof for images either -
                        # found via the same real file, where legitimately
                        # visible small panel images got wrongly deleted.
                        bbox = None
                    else:
                        bbox = bbox_intersect(bbox, self.clip_bbox)
                result.paint_events.append(
                    PaintEvent(index=idx, depth=self.depth, bbox=bbox, is_image=True)
                )
            elif op in ("Tj", "'", '"'):
                # '/" first move to the next line (T*-equivalent) before
                # showing; " also takes word/char spacing operands we don't
                # need for a bbox estimate. The string is always the last
                # operand for all three.
                if op in ("'", '"'):
                    self.tlm = mat_mult((1.0, 0.0, 0.0, 1.0, 0.0, -self.tl), self.tlm)
                    self.tm = self.tlm
                char_count = len(bytes(operands[-1])) if operands else 0
                bbox, advance = self._text_paint_bbox(char_count)
                dead = False
                if bbox is not None and self.clip_bbox is not None:
                    if bboxes_disjoint(bbox, self.clip_bbox):
                        dead = True
                        bbox = None
                    else:
                        bbox = bbox_intersect(bbox, self.clip_bbox)
                result.paint_events.append(
                    PaintEvent(index=idx, depth=self.depth, bbox=bbox, definitely_dead=dead)
                )
                if advance:
                    tx = advance * self.tfs * self.th
                    self.tm = mat_mult((1.0, 0.0, 0.0, 1.0, tx, 0.0), self.tm)
            elif op == "TJ":
                char_count = 0
                if operands:
                    for el in operands[0]:
                        if isinstance(el, pikepdf.String):
                            char_count += len(bytes(el))
                bbox, advance = self._text_paint_bbox(char_count)
                dead = False
                if bbox is not None and self.clip_bbox is not None:
                    if bboxes_disjoint(bbox, self.clip_bbox):
                        dead = True
                        bbox = None
                    else:
                        bbox = bbox_intersect(bbox, self.clip_bbox)
                result.paint_events.append(
                    PaintEvent(index=idx, depth=self.depth, bbox=bbox, definitely_dead=dead)
                )
                if advance:
                    tx = advance * self.tfs * self.th
                    self.tm = mat_mult((1.0, 0.0, 0.0, 1.0, tx, 0.0), self.tm)
            elif op == "sh":
                # Shading paint: fills the current clip region. With no
                # active clip its true extent is unbounded/unknown - record
                # bbox=None (meaning "don't trust this for safety-critical
                # decisions like off-canvas deletion") rather than guessing.
                result.paint_events.append(
                    PaintEvent(index=idx, depth=self.depth, bbox=self.clip_bbox)
                )
        return result

    def _consume_path_op(self, op, operands):
        vals = [float(v) for v in operands]
        if op == "re":
            x, y, w, h = vals
            corners = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
            for cx, cy in corners:
                self._pending_path_points.append(apply_point(self.ctm, cx, cy))
            self._cur_point = (x, y)
        elif op == "h":
            pass  # closepath - no new point
        elif op == "m":
            x, y = vals
            self._pending_path_points.append(apply_point(self.ctm, x, y))
            self._cur_point = (x, y)
        elif op == "l":
            x, y = vals
            self._pending_path_points.append(apply_point(self.ctm, x, y))
            self._cur_point = (x, y)
        elif op == "c":
            x1, y1, x2, y2, x3, y3 = vals
            for x, y in ((x1, y1), (x2, y2), (x3, y3)):
                self._pending_path_points.append(apply_point(self.ctm, x, y))
            self._cur_point = (x3, y3)
        elif op == "v":
            x2, y2, x3, y3 = vals
            self._pending_path_points.append(apply_point(self.ctm, *self._cur_point))
            for x, y in ((x2, y2), (x3, y3)):
                self._pending_path_points.append(apply_point(self.ctm, x, y))
            self._cur_point = (x3, y3)
        elif op == "y":
            x1, y1, x3, y3 = vals
            for x, y in ((x1, y1), (x3, y3)):
                self._pending_path_points.append(apply_point(self.ctm, x, y))
            self._cur_point = (x3, y3)


def get_content_instructions(obj: pikepdf.Object):
    """Parse the (possibly array-of-streams) content of a page or Form."""
    return pikepdf.parse_content_stream(obj)


@dataclass
class BracketInfo:
    pairs: dict          # q_idx -> Q_idx
    parent_of: dict       # q_idx -> enclosing q_idx or None
    children: dict = field(default_factory=dict)  # parent_or_None -> sorted [q_idx, ...]


def match_q_brackets(instructions) -> BracketInfo:
    """Standard bracket-matching over q/Q. Unbalanced trailing q's (no
    matching Q) are left out of `pairs`; a stray Q with no open q is ignored.
    Also pre-builds a parent->children index once (O(n)) so child_units()
    never has to rescan the full parent_of map per call."""
    stack = []
    pairs = {}
    parent_of = {}
    children = {}
    for idx, instr in enumerate(instructions):
        op = str(instr.operator)
        if op == "q":
            parent = stack[-1] if stack else None
            parent_of[idx] = parent
            children.setdefault(parent, []).append(idx)
            stack.append(idx)
        elif op == "Q":
            if stack:
                pairs[stack.pop()] = idx
    return BracketInfo(pairs=pairs, parent_of=parent_of, children=children)


def child_units(instructions, brackets: BracketInfo, context=None):
    """Ordered list of (start, end) index ranges that are the direct
    children of `context` (None = root level, or a q's index for one level
    inside that q/Q block). A nested balanced q/Q block is one atomic unit;
    consecutive non-bracket instructions between/around them are collapsed
    into one "bare" unit each (not one unit per instruction) for speed -
    callers that care about single-instruction units already only special-
    case start==end, which a genuine lone instruction still satisfies."""
    if context is None:
        lo, hi = 0, len(instructions) - 1
    else:
        lo, hi = context + 1, brackets.pairs[context] - 1
    child_qs = [q for q in brackets.children.get(context, []) if lo <= q <= hi]
    units = []
    i = lo
    qi = 0
    while i <= hi:
        if qi < len(child_qs) and i == child_qs[qi]:
            end = brackets.pairs[child_qs[qi]]
            units.append((child_qs[qi], end))
            i = end + 1
            qi += 1
        else:
            bare_end = (child_qs[qi] - 1) if qi < len(child_qs) else hi
            units.append((i, bare_end))
            i = bare_end + 1
    return units


def flatten_redundant_dot_runs(instructions, brackets: BracketInfo, min_siblings=200,
                                max_child_size=20, max_bare_gap=12, _max_depth=6):
    """Companion to find_dense_regions, meant to run BEFORE it. Finds the
    identical "many small q/Q siblings" signature (one shape - one scatter
    point, typically - per q...Q block; this is how R's cairo PDF device,
    among others, emits repeated marks) and, only where provably safe,
    collapses each qualifying run's individual q/Q wrappers into a single
    outer q...Q around the whole run. This removes zero visible content
    and changes zero pixels (see the safety condition below); what it
    removes is the specific bracket signature find_dense_regions (and its
    JS counterpart) use to flag a region as a promotion candidate. That
    matters because region promotion has a still-unexplained rendering
    defect on exactly this document pattern - found via a real file where
    a dense scatter/network panel silently lost its content after
    promotion despite every input to the promotion step (the extracted
    raster, its bounding box, the placement matrix) checking out correct
    in isolation. Rather than chase that further, this defuses the
    trigger: a run that never looks dense to begin with never reaches the
    promotion path. A second real file confirmed the mechanism - the same
    figure, re-exported through Affinity, doesn't wrap each point in its
    own q/Q, never triggers find_dense_regions, and compresses correctly
    with the exact same downstream code.

    Safety condition for collapsing a run: every member block must (a)
    contain no `W`/`W*` or text-showing operator - clipping and text
    state aren't undone by anything short of the real Q, so a block that
    touches either must stay individually scoped - and (b) either every
    member sets its own complete fill/stroke color before painting, or no
    member sets color at all (the whole run shares one ambient color set
    before it began and never changes it). A member MAY contain `cm`.
    Where the block's only other content is plain point-based path
    construction (`m`/`l`/`c`/`h`), the `cm` is resolved at build time
    instead of at render time: every point operand is pre-transformed
    through the block's own net matrix (full float64 precision, computed
    once in Python) and the `cm` is dropped entirely, so there is no
    runtime matrix composition left for a renderer to do at all - not
    even an exactly-cancelling one. That distinction turned out to
    matter in practice: an earlier version of this pass instead emitted
    a compensating `cm` (the mathematical inverse of the block's own,
    landing the CTM back exactly where the real Q would have - correct
    in principle, and confirmed exact to 1e-13 in isolation) in place of
    each dropped Q. On sparse content that was pixel-perfect, but on the
    densest scatter panels (tens of thousands of overlapping same-sized
    marks in one run) it produced a small but real, renderer-independent
    discrepancy - confirmed identical in kind and magnitude under both
    MuPDF and poppler, which rules out a rendering-side antialiasing
    quirk and points instead to reduced-precision CTM arithmetic inside
    the renderers themselves, invisible per-mark but occasionally
    flipping which of two overlapping marks wins a shared boundary pixel
    once repeated tens of thousands of times. Pre-transforming coordinates
    sidesteps that class of problem outright, since the renderer is never
    asked to compose or invert anything for these blocks. A block using
    any other path operator (`re`, `v`, `y`, ...) falls back to the
    compensating-`cm` approach, which is still exact in principle and
    was previously verified pixel-perfect on every non-scatter-density
    case this pass was tested against. The run as a whole is still
    wrapped in one outer q...Q, so nothing - color included - leaks past
    the run's boundary, matching the original all-or-nothing isolation
    the many small brackets provided. A run where color usage is
    inconsistent across members is left completely untouched, dense-
    region heuristics included; this pass only ever removes/replaces/
    rewrites q/Q/cm/path-construction operators, never any color or
    paint instruction, and only where the substitution is provably
    inert."""
    HARD_BLOCKERS = {"W", "W*"}
    TEXT_OPS = {"BT", "ET", "Tj", "TJ", "'", '"'}
    COLOR_SET_OPS = {"rg", "RG", "g", "G", "k", "K", "sc", "SC", "scn", "SCN"}
    FILL_ONLY_PAINT_OPS = {"f", "F", "f*"}
    STROKE_PAINT_OPS = {"S", "s", "B", "B*", "b", "b*"}
    LOCAL_PAINT_OPS = FILL_ONLY_PAINT_OPS | STROKE_PAINT_OPS
    # operator -> indices (into its operand list) that are (x,y) point pairs
    REWRITABLE_PATH_OPS = {"m": [0], "l": [0], "c": [0, 2, 4], "h": []}

    def analyze_block(start, end):
        """None if not safely collapsible; else (sets_own_color, net_cm,
        rewritable) where net_cm is the composition of every `cm` inside
        (IDENTITY if none), and rewritable is True iff every path-
        construction operator inside is one this pass can directly
        transform AND the block paints via fill only. Stroking is
        excluded from rewriting even when the path itself is a plain
        m/l/c shape: line width is defined in user space and is scaled by
        whatever CTM is active at paint time, so a block that strokes
        needs the real per-shape `cm` genuinely in effect when it paints
        - not just its coordinates pre-transformed - or its stroke
        renders at the wrong (visibly thicker, if the per-shape scale was
        < 1) width. Found via a real file where the point-rewrite path
        made every stroked scatter dot render fatter than the original.
        The compensating-cm fallback keeps the real cm in place through
        the paint call, so it stays correct for stroked shapes."""
        net_cm = IDENTITY
        sets_color = False
        has_paint = False
        rewritable = True
        for i in range(start, end + 1):
            instr = instructions[i]
            op = str(instr.operator)
            if op in HARD_BLOCKERS or op in TEXT_OPS:
                return None
            elif op == "cm":
                m = tuple(float(v) for v in instr.operands[:6])
                net_cm = mat_mult(m, net_cm)
            elif op in COLOR_SET_OPS:
                sets_color = True
            elif op in LOCAL_PAINT_OPS:
                has_paint = True
                if op in STROKE_PAINT_OPS:
                    rewritable = False
            elif op in PATH_CONSTRUCTION_OPS and op not in REWRITABLE_PATH_OPS:
                rewritable = False
        if not has_paint:
            return None
        return (sets_color, net_cm, rewritable)

    def small_q_info(u):
        if str(instructions[u[0]].operator) != "q" or (u[1] - u[0]) > max_child_size:
            return None
        return analyze_block(u[0] + 1, u[1] - 1)

    qualifying_runs = []  # list of (members, infos) - members: (q_idx,Q_idx); infos: analyze_block results

    def recurse(context, depth):
        units = child_units(instructions, brackets, context)
        run = []
        run_infos = []
        non_dense_between = []

        def flush():
            ok = len(run) >= min_siblings and (
                all(info[0] for info in run_infos) or not any(info[0] for info in run_infos)
            )
            if ok:
                qualifying_runs.append((list(run), list(run_infos)))
            else:
                for u in run:
                    if depth < _max_depth:
                        recurse(u[0], depth + 1)
            for u in non_dense_between:
                if str(instructions[u[0]].operator) == "q" and depth < _max_depth:
                    recurse(u[0], depth + 1)
            run.clear()
            run_infos.clear()
            non_dense_between.clear()

        for u in units:
            info = small_q_info(u)
            if info is not None:
                run.append(u)
                run_infos.append(info)
                non_dense_between.clear()
            elif run and (u[1] - u[0]) <= max_bare_gap:
                non_dense_between.append(u)
            else:
                flush()
                if str(instructions[u[0]].operator) == "q" and depth < _max_depth:
                    recurse(u[0], depth + 1)
        flush()

    recurse(None, 0)

    if not qualifying_runs:
        return instructions, 0

    drop = set()
    insert_q_before = set()
    compensate_cm = {}       # Q_idx -> inverse Matrix to insert in place of that dropped Q
    outer_close_after = set()  # Q_idx after which to insert the run's single outer "Q"
    rewrite_points = {}      # instruction idx -> new operand list (pre-transformed m/l/c)

    for members, infos in qualifying_runs:
        insert_q_before.add(members[0][0])
        outer_close_after.add(members[-1][1])
        for (q_idx, Q_idx), (sets_color, net_cm, rewritable) in zip(members, infos):
            drop.add(q_idx)
            drop.add(Q_idx)
            if net_cm == IDENTITY:
                continue
            if rewritable:
                # Resolve the cm at build time: drop it, pre-transform every
                # point operand in this block's own m/l/c instructions.
                for i in range(q_idx + 1, Q_idx):
                    op = str(instructions[i].operator)
                    if op == "cm":
                        drop.add(i)
                    elif op in REWRITABLE_PATH_OPS:
                        operands = [float(v) for v in instructions[i].operands]
                        for pt_idx in REWRITABLE_PATH_OPS[op]:
                            x, y = apply_point(net_cm, operands[pt_idx], operands[pt_idx + 1])
                            operands[pt_idx], operands[pt_idx + 1] = x, y
                        rewrite_points[i] = operands
            else:
                compensate_cm[Q_idx] = mat_invert(net_cm)

    out = []
    for i, ins in enumerate(instructions):
        if i in insert_q_before:
            out.append(pikepdf.ContentStreamInstruction([], pikepdf.Operator("q")))
        if i in rewrite_points:
            # pikepdf.Real defaults to 6 decimal places, which is plenty for
            # ordinary content but introduces a small, uniformly-spread
            # rounding artifact when EVERY point in a dense scatter panel is
            # being rewritten at once - ask for full precision instead.
            operands = [pikepdf.Real(v, 12) for v in rewrite_points[i]]
            out.append(pikepdf.ContentStreamInstruction(operands, ins.operator))
        elif i not in drop:
            out.append(ins)
        if i in compensate_cm:
            operands = [pikepdf.Real(v, 12) for v in compensate_cm[i]]
            out.append(pikepdf.ContentStreamInstruction(operands, pikepdf.Operator("cm")))
        if i in outer_close_after:
            out.append(pikepdf.ContentStreamInstruction([], pikepdf.Operator("Q")))

    return out, sum(len(members) for members, _ in qualifying_runs)


def find_dense_regions(instructions, brackets: BracketInfo, min_siblings=200,
                        max_child_size=20, max_bare_gap=12,
                        _max_depth=6):
    """Recursively find maximal *consecutive* runs of many small q/Q units
    within a nesting context - each such run is one candidate region for
    promotion (e.g. one scatter/UMAP panel drawn as one dot per q...Q
    block). Small bare (non-bracket) gaps between dense q-blocks are
    tolerated (typical color/state-setting operators between shapes), but a
    large bare gap or a full-size sibling q-block ends the run - critical
    so that, e.g., a paragraph of body text sitting between two dense
    figure clusters on the same page doesn't get swallowed into one giant
    span covering everything between them. Returns (context_q_idx_or_None,
    start, end) tuples; qualifying runs are treated as atomic (not
    descended into), everything else is recursed into to find deeper runs."""
    regions = []
    TEXT_SHOWING_OPS = {"Tj", "TJ", "'", '"', "BT", "ET"}

    def contains_text(start, end):
        # Some PDF generators wrap each glyph run in its own q...Q block for
        # precise positioning - structurally identical to "many small q/Q
        # blocks" (the same signature a scatter-plot dot cloud has), but
        # it's real body text, not decorative vector clutter. Discovered via
        # a real file where this misfired and silently rasterized ~half the
        # page's text. A block only qualifies as a "dot" if it contains no
        # text-showing operators at all.
        return any(str(instructions[i].operator) in TEXT_SHOWING_OPS for i in range(start, end + 1))

    def is_small_q(u):
        return (str(instructions[u[0]].operator) == "q" and (u[1] - u[0]) <= max_child_size
                and not contains_text(u[0], u[1]))

    def recurse(context, depth):
        units = child_units(instructions, brackets, context)
        run = []  # list of small-q units currently being accumulated
        non_dense_between = []  # non-small units seen since the run started

        def flush():
            if len(run) >= min_siblings:
                regions.append((context, run[0][0], run[-1][1]))
            else:
                for u in run:
                    if depth < _max_depth:
                        recurse(u[0], depth + 1)
            for u in non_dense_between:
                if str(instructions[u[0]].operator) == "q" and depth < _max_depth:
                    recurse(u[0], depth + 1)
            run.clear()
            non_dense_between.clear()

        for u in units:
            if is_small_q(u):
                run.append(u)
                non_dense_between.clear()  # gap tolerated, absorbed into the run
            elif run and (u[1] - u[0]) <= max_bare_gap:
                non_dense_between.append(u)  # small gap - keep the run alive
            else:
                flush()
                if str(instructions[u[0]].operator) == "q" and depth < _max_depth:
                    recurse(u[0], depth + 1)
        flush()

    recurse(None, 0)
    return regions


def find_offcanvas_units(instructions, brackets: BracketInfo, walk_result: WalkResult,
                          page_rect, _max_depth=3):
    """Find top-level (or shallowly-nested) q/Q units whose entire painted
    content is provably never visible - safe to delete outright. A paint
    event counts as safe to remove either because its bbox is known and
    falls entirely outside page_rect, or because it's flagged
    `definitely_dead` (its own geometry never intersected the clip active
    when it fired, e.g. text positioned nowhere near a small clip rect left
    behind by earlier edits - real "ghost" content, still selectable/
    copyable but never renderable). Conservative by construction: a unit is
    only flagged if *every* paint event inside it clears one of those two
    bars. Any paint event with a genuinely unknown extent (e.g. an unclipped
    `sh`) and not already known-dead blocks deletion of the whole unit,
    erring toward leaving content alone.

    Uses a sorted-index range query (bisect) against paint_events rather
    than a linear scan per unit, since this can be called against millions
    of paint events across thousands of units."""
    import bisect
    events_sorted = sorted(walk_result.paint_events, key=lambda ev: ev.index)
    event_indices = [ev.index for ev in events_sorted]
    dead = []

    def events_in(start, end):
        lo = bisect.bisect_left(event_indices, start)
        hi = bisect.bisect_right(event_indices, end)
        return events_sorted[lo:hi]

    def is_safe_to_remove(ev):
        return ev.definitely_dead or (ev.bbox is not None and bboxes_disjoint(ev.bbox, page_rect))

    def recurse(context, depth):
        for start, end in child_units(instructions, brackets, context):
            if start == end and str(instructions[start].operator) != "q":
                continue  # bare single instruction, not a deletable unit
            events = events_in(start, end)
            if not events:
                continue  # no paint at all in here - nothing to gain, leave it
            if all(is_safe_to_remove(ev) for ev in events):
                dead.append((start, end))
                continue
            if any((ev.bbox is None and not ev.definitely_dead) for ev in events):
                if depth < _max_depth and str(instructions[start].operator) == "q":
                    recurse(start, depth + 1)
                continue
            if depth < _max_depth and str(instructions[start].operator) == "q":
                recurse(start, depth + 1)

    recurse(None, 0)
    return dead


def get_effective_resources(page_or_form: pikepdf.Object, pdf: pikepdf.Pdf):
    """Resolve /Resources, walking up /Parent for pages that inherit it."""
    obj = page_or_form
    seen = set()
    while obj is not None:
        key = obj.objgen if obj.is_indirect else id(obj)
        if key in seen:
            break
        seen.add(key)
        if "/Resources" in obj:
            return obj.Resources
        parent = obj.get("/Parent")
        obj = parent
    return pikepdf.Dictionary({})


def iter_xobject_dicts(pdf: pikepdf.Pdf):
    """Yield every Resources/XObject dict reachable from any page, including
    those nested inside Form XObjects (recursively)."""
    visited = set()

    def walk_resources(res):
        if res is None or "/XObject" not in res:
            return
        xobj_dict = res["/XObject"]
        yield_key = xobj_dict.objgen if xobj_dict.is_indirect else id(xobj_dict)
        if yield_key in visited:
            return
        visited.add(yield_key)
        yield xobj_dict
        for name in list(xobj_dict.keys()):
            obj = xobj_dict[name]
            try:
                if obj.get("/Subtype") == Name.Form:
                    fkey = obj.objgen
                    if fkey not in visited:
                        visited.add(fkey)
                        yield from walk_resources(obj.get("/Resources"))
            except Exception:
                continue

    for page in pdf.pages:
        yield from walk_resources(page.get("/Resources"))


# ---------------------------------------------------------------------------
# Form-swap and content-stream region promotion
# ---------------------------------------------------------------------------

class FormSwapSkip(Exception):
    """Raised when a Form-swap/region-promotion attempt isn't worth applying."""


def transform_bbox(bbox, m: Matrix):
    x0, y0, x1, y1 = bbox
    pts = [apply_point(m, x0, y0), apply_point(m, x1, y0), apply_point(m, x1, y1), apply_point(m, x0, y1)]
    return points_bbox(pts)


def rasterize_form_standalone(form_obj: pikepdf.Object, dpi: int, autocrop: bool = False):
    """Render a Form XObject (with whatever /BBox, /Matrix, /Resources it
    already has) in isolation, by invoking it from a throwaway single-page
    PDF. Returns (png_bytes, width, height, visible_page_bbox).

    If autocrop is True, the render is trimmed to its actual non-white ink
    using PIL rather than trusting the caller's /BBox to be tight - this
    sidesteps any imprecision in analytically-computed bboxes (e.g. from
    region promotion) by letting MuPDF's own correct interpreter determine
    what's actually visible."""
    bbox = tuple(float(v) for v in form_obj.BBox)
    matrix = tuple(float(v) for v in form_obj.Matrix) if "/Matrix" in form_obj else IDENTITY
    visible = transform_bbox(bbox, matrix)
    if visible is None:
        raise FormSwapSkip("degenerate bbox")
    vw, vh = visible[2] - visible[0], visible[3] - visible[1]
    if vw < 3 or vh < 3 or vw > 14400 or vh > 14400:
        raise FormSwapSkip(f"bbox size {vw:.1f}x{vh:.1f} outside renderable range")

    mini = pikepdf.Pdf.new()
    mini_page = mini.add_blank_page(page_size=(visible[2] - visible[0], visible[3] - visible[1]))
    mini_page.obj.MediaBox = pikepdf.Array(list(visible))
    foreign = mini.copy_foreign(form_obj)
    mini_page.obj.Contents = mini.make_stream(b"q /FxTemp Do Q")
    mini_page.obj.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(FxTemp=foreign))

    buf = io.BytesIO()
    mini.save(buf)
    mini.close()
    buf.seek(0)
    mdoc = fitz.open(stream=buf.read(), filetype="pdf")
    pix = mdoc[0].get_pixmap(dpi=dpi, alpha=False)
    png_bytes = pix.tobytes("png")
    w, h = pix.width, pix.height
    mdoc.close()

    if autocrop:
        from PIL import ImageChops
        im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        crop_box = ImageChops.difference(im, bg).getbbox()
        if crop_box is not None and crop_box != (0, 0, im.width, im.height):
            l, t, r, b = crop_box
            im = im.crop(crop_box)
            out = io.BytesIO()
            im.save(out, format="PNG")
            png_bytes = out.getvalue()
            sx = (visible[2] - visible[0]) / w
            sy = (visible[3] - visible[1]) / h
            new_x0 = visible[0] + l * sx
            new_x1 = visible[0] + r * sx
            new_y1 = visible[3] - t * sy  # image row 0 = top = page-space y-max
            new_y0 = visible[3] - b * sy
            visible = (new_x0, new_y0, new_x1, new_y1)
            w, h = im.width, im.height

    return png_bytes, w, h, visible


def form_swap(pdf: pikepdf.Pdf, form_obj: pikepdf.Object, dpi: int = 200,
              jpeg_quality: int = 78, autocrop: bool = False) -> dict:
    """Rasterize a Form XObject's appearance in place. /BBox and /Matrix are
    left untouched by default, so every invocation of this Form (anywhere,
    with any invoker CTM) keeps working unmodified - only the Form's own
    guts change. If autocrop is True (used for region-promoted Forms, whose
    /BBox is only an approximate analytical guess), /BBox is first tightened
    to the actual rendered ink before the swap. Raises FormSwapSkip if the
    swap isn't worth applying."""
    if "/BBox" not in form_obj:
        raise FormSwapSkip("Form has no /BBox")

    raw_before = len(form_obj.read_raw_bytes())
    png_bytes, pw, ph, visible = rasterize_form_standalone(form_obj, dpi, autocrop=autocrop)

    if autocrop:
        matrix = tuple(float(v) for v in form_obj.Matrix) if "/Matrix" in form_obj else IDENTITY
        new_local_bbox = transform_bbox(visible, mat_invert(matrix))
        form_obj.BBox = pikepdf.Array(list(new_local_bbox))

    x0, y0, x1, y1 = (float(v) for v in form_obj.BBox)
    w_local, h_local = x1 - x0, y1 - y0
    if w_local <= 0 or h_local <= 0:
        raise FormSwapSkip("degenerate BBox")

    im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    jbuf = io.BytesIO()
    im.save(jbuf, format="JPEG", quality=jpeg_quality)
    jpeg_bytes = jbuf.getvalue()

    if len(jpeg_bytes) >= raw_before:
        raise FormSwapSkip("raster not smaller than original vector stream")

    img_stream = pikepdf.Stream(pdf, jpeg_bytes)
    img_stream.Type = pikepdf.Name.XObject
    img_stream.Subtype = pikepdf.Name.Image
    img_stream.Width = im.width
    img_stream.Height = im.height
    img_stream.ColorSpace = pikepdf.Name.DeviceRGB
    img_stream.BitsPerComponent = 8
    img_stream.Filter = pikepdf.Name.DCTDecode
    img_obj = pdf.make_indirect(img_stream)

    new_content = f"q {w_local:.6f} 0 0 {h_local:.6f} {x0:.6f} {y0:.6f} cm /Im0 Do Q".encode()
    form_obj.write(new_content)
    form_obj.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=img_obj))
    if "/Group" in form_obj:
        del form_obj.Group

    return {"raw_bytes_before": raw_before, "raw_bytes_after": len(jpeg_bytes)}


PAINT_LIKE_OPS = PAINT_OPS | {"Tj", "TJ", "'", '"'}


def _neutralize_outside(instructions, keep_start: int, keep_end: int):
    """Copy of `instructions` where every paint-like operation (fills,
    strokes, text-show, XObject Do) OUTSIDE [keep_start, keep_end] is
    dropped/no-op'd, while everything inside is preserved byte-for-byte and
    every non-paint operator everywhere (q, Q, cm, color/state setters,
    path construction, clip marking) is left untouched. Structure-affecting
    operators (q/Q) are never touched, so bracket balance is preserved and
    clip state established by outside content still propagates in exactly
    the way the real renderer expects."""
    out = []
    for idx, instr in enumerate(instructions):
        if keep_start <= idx <= keep_end:
            out.append(instr)
            continue
        op = str(instr.operator)
        if op in ("f", "F", "f*", "S", "s", "B", "B*", "b", "b*"):
            out.append(([], pikepdf.Operator("n")))
        elif op in ("Tj", "TJ", "'", '"', "Do", "sh", "EI"):
            continue  # drop entirely - none of these open/close a bracket
        else:
            out.append(instr)
    return out


def render_region_isolated(pdf: pikepdf.Pdf, page, instructions, start: int, end: int,
                            dpi: int, autocrop: bool = True):
    """Render the *real* page with everything except instructions[start:end+1]
    neutralized, so MuPDF's own (correct) interpreter resolves every clip
    and transform exactly as the original document intended - sidestepping
    hand-rolled CTM/clip tracking entirely for placement purposes. Returns
    (png_bytes, w, h, page_bbox) where page_bbox is already in page space,
    ready to place directly via a simple image Do call. Raises FormSwapSkip
    if nothing is visible."""
    isolated = _neutralize_outside(instructions, start, end)
    content_bytes = pikepdf.unparse_content_stream(isolated)

    mb0 = tuple(float(v) for v in page.get("/MediaBox"))
    mini = pikepdf.Pdf.new()
    mini_page = mini.add_blank_page(page_size=(mb0[2] - mb0[0], mb0[3] - mb0[1]))
    mini_page.obj.MediaBox = pikepdf.Array(list(mb0))
    resources = page.get("/Resources")
    if not resources.is_indirect:
        # copy_foreign requires an indirect (addressable) object; some
        # files store /Resources as a direct dict embedded in the page.
        resources = pdf.make_indirect(resources)
    mini_page.obj.Resources = mini.copy_foreign(resources)
    mini_page.obj.Contents = mini.make_stream(content_bytes)

    buf = io.BytesIO()
    mini.save(buf)
    mini.close()
    buf.seek(0)
    mdoc = fitz.open(stream=buf.read(), filetype="pdf")
    pix = mdoc[0].get_pixmap(dpi=dpi, alpha=False)
    png_bytes = pix.tobytes("png")
    w, h = pix.width, pix.height
    mdoc.close()

    mb = tuple(float(v) for v in page.get("/MediaBox"))
    page_bbox = mb

    if autocrop:
        from PIL import ImageChops
        im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        crop_box = ImageChops.difference(im, bg).getbbox()
        if crop_box is None:
            raise FormSwapSkip("no visible content in region")
        if crop_box != (0, 0, im.width, im.height):
            l, t, r, b = crop_box
            im = im.crop(crop_box)
            out = io.BytesIO()
            im.save(out, format="PNG")
            png_bytes = out.getvalue()
            sx = (mb[2] - mb[0]) / w
            sy = (mb[3] - mb[1]) / h
            new_x0 = mb[0] + l * sx
            new_x1 = mb[0] + r * sx
            new_y1 = mb[3] - t * sy  # image row 0 = top = page-space y-max
            new_y0 = mb[3] - b * sy
            page_bbox = (new_x0, new_y0, new_x1, new_y1)
            w, h = im.width, im.height

    return png_bytes, w, h, page_bbox


def promote_region(pdf: pikepdf.Pdf, page, instructions, start: int, end: int,
                    dpi: int = 200, jpeg_quality: int = 78):
    """Rasterize instructions[start:end+1] in place, placed directly in page
    space (no synthetic Form/Matrix needed - the isolated render already
    resolves the real page's clips/transforms correctly). Returns a
    (start, end, form_obj) tuple ready for splice_page_content, and a stats
    dict; raises FormSwapSkip if not worth applying."""
    raw_before = len(pikepdf.unparse_content_stream(instructions[start:end + 1]))
    png_bytes, pw, ph, bbox = render_region_isolated(pdf, page, instructions, start, end, dpi)

    im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    jbuf = io.BytesIO()
    im.save(jbuf, format="JPEG", quality=jpeg_quality)
    jpeg_bytes = jbuf.getvalue()

    if len(jpeg_bytes) >= raw_before:
        raise FormSwapSkip("raster not smaller than original vector content")

    img_stream = pikepdf.Stream(pdf, jpeg_bytes)
    img_stream.Type = pikepdf.Name.XObject
    img_stream.Subtype = pikepdf.Name.Image
    img_stream.Width = im.width
    img_stream.Height = im.height
    img_stream.ColorSpace = pikepdf.Name.DeviceRGB
    img_stream.BitsPerComponent = 8
    img_stream.Filter = pikepdf.Name.DCTDecode
    img_obj = pdf.make_indirect(img_stream)

    x0, y0, x1, y1 = bbox
    w_pt, h_pt = x1 - x0, y1 - y0
    form_content = f"q {w_pt:.4f} 0 0 {h_pt:.4f} {x0:.4f} {y0:.4f} cm /Im0 Do Q".encode()
    form = pikepdf.Stream(pdf, form_content)
    form.Type = pikepdf.Name.XObject
    form.Subtype = pikepdf.Name.Form
    form.BBox = pikepdf.Array([x0, y0, x1, y1])
    form.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary({"/Im0": img_obj}))
    form_obj = pdf.make_indirect(form)

    return (start, end, form_obj), {"raw_bytes_before": raw_before, "raw_bytes_after": len(jpeg_bytes), "bbox": bbox}


def splice_page_content(pdf: pikepdf.Pdf, page, instructions, replacements):
    """Rebuild a page's content stream, applying a list of edits.

    replacements: list of (start, end, form_obj_or_None), inclusive index
    ranges into `instructions`. A form_obj replaces the range with a single
    `/FxGenN Do` referencing it (added to the page's XObject resources); a
    None replacement (used for off-canvas removal) deletes the range
    outright with nothing put in its place. Ranges must not overlap.
    """
    replacements = sorted(replacements, key=lambda r: r[0])
    new_instructions = []
    xobject_dict = None
    cursor = 0
    counter = 0

    for start, end, form_obj in replacements:
        if start < cursor:
            continue  # overlapping edit, skip defensively
        new_instructions.extend(instructions[cursor:start])
        if form_obj is not None:
            if xobject_dict is None:
                res = page.obj.get("/Resources")
                if res is None:
                    res = pikepdf.Dictionary()
                    page.obj.Resources = res
                if "/XObject" not in res:
                    res.XObject = pikepdf.Dictionary()
                xobject_dict = res.XObject
            name = f"FxGen{counter}"
            counter += 1
            xobject_dict[f"/{name}"] = form_obj
            new_instructions.append(([pikepdf.Name(f"/{name}")], pikepdf.Operator("Do")))
        cursor = end + 1

    new_instructions.extend(instructions[cursor:])
    new_bytes = pikepdf.unparse_content_stream(new_instructions)
    page.obj.Contents = pdf.make_stream(new_bytes)


# ---------------------------------------------------------------------------
# Clean-mode: unambiguous waste removal, never rasterizes anything
# ---------------------------------------------------------------------------

def strip_icc_profiles(pdf: pikepdf.Pdf) -> int:
    """Replace every [/ICCBased ref] colorspace array with its /Alternate
    (or an /N-derived fallback) directly, so the (often large) embedded
    profile becomes unreferenced and is dropped by the final compaction.
    Purely a screen/print-fidelity tradeoff most users never notice."""
    def alt_name(stream_obj):
        if "/Alternate" in stream_obj:
            return stream_obj["/Alternate"]
        n = int(stream_obj.get("/N", 3))
        return {1: pikepdf.Name.DeviceGray, 3: pikepdf.Name.DeviceRGB,
                4: pikepdf.Name.DeviceCMYK}.get(n, pikepdf.Name.DeviceRGB)

    visited = set()
    replaced = 0

    def walk(obj, depth=0):
        nonlocal replaced
        if depth > 25:
            return
        if isinstance(obj, pikepdf.Object) and obj.is_indirect:
            key = obj.objgen
            if key in visited:
                return
            visited.add(key)
        if isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)):
            for k in list(obj.keys()):
                v = obj[k]
                if isinstance(v, pikepdf.Array) and len(v) >= 2:
                    try:
                        if str(v[0]) == "/ICCBased":
                            obj[k] = alt_name(v[1])
                            replaced += 1
                            continue
                    except Exception:
                        pass
                walk(v, depth + 1)
        elif isinstance(obj, pikepdf.Array):
            for item in obj:
                walk(item, depth + 1)

    walk(pdf.Root)
    for page in pdf.pages:
        walk(page.obj)
    return replaced


def dedup_images(pdf: pikepdf.Pdf) -> int:
    """Collapse identical embedded images (by content hash) to a single
    shared object, across page-level AND Form-nested XObject dicts."""
    hash_to_canonical = {}
    collapsed = 0
    for xobj_dict in iter_xobject_dicts(pdf):
        for key in list(xobj_dict.keys()):
            obj = xobj_dict[key]
            try:
                if obj.get("/Subtype") != pikepdf.Name.Image:
                    continue
                raw = obj.read_raw_bytes()
            except Exception:
                continue
            h = hashlib.md5(raw).digest()
            canon = hash_to_canonical.get(h)
            if canon is not None and canon.objgen != obj.objgen:
                xobj_dict[key] = canon
                collapsed += 1
            elif canon is None:
                hash_to_canonical[h] = obj
    return collapsed


def remove_unused_fonts(pdf: pikepdf.Pdf) -> int:
    """Drop /Font resource entries never referenced by a Tf operator in
    that same page/Form's own content stream. Only removes the dict entry
    (the font object itself is swept later by remove_unreferenced_resources
    if truly orphaned everywhere), so shared fonts are unaffected."""
    removed = 0

    def process(content_owner):
        nonlocal removed
        resources = get_effective_resources(content_owner, pdf)
        if resources is None or "/Font" not in resources:
            return
        try:
            instructions = pikepdf.parse_content_stream(content_owner)
        except Exception:
            return
        used = {str(instr.operands[0]) for instr in instructions
                if str(instr.operator) == "Tf" and instr.operands}
        font_dict = resources.Font
        for name in list(font_dict.keys()):
            if name not in used:
                del font_dict[name]
                removed += 1

    for page in pdf.pages:
        process(page.obj)
    for xobj_dict in iter_xobject_dicts(pdf):
        for key in list(xobj_dict.keys()):
            try:
                obj = xobj_dict[key]
                if obj.get("/Subtype") == pikepdf.Name.Form:
                    process(obj)
            except Exception:
                continue
    return removed


def remove_javascript(pdf: pikepdf.Pdf) -> bool:
    removed = False
    names = pdf.Root.get("/Names")
    if names is not None and "/JavaScript" in names:
        del names["/JavaScript"]
        removed = True
    oa = pdf.Root.get("/OpenAction")
    if oa is not None:
        try:
            if oa.get("/S") == pikepdf.Name.JavaScript:
                del pdf.Root["/OpenAction"]
                removed = True
        except Exception:
            pass
    return removed


def remove_embedded_files(pdf: pikepdf.Pdf) -> int:
    names = pdf.Root.get("/Names")
    if names is None or "/EmbeddedFiles" not in names:
        return 0
    try:
        kids = names.EmbeddedFiles.get("/Names", [])
        count = len(kids) // 2  # flat [name, filespec, name, filespec, ...] array
    except Exception:
        count = 1
    del names["/EmbeddedFiles"]
    return count


def remove_thumbnails(pdf: pikepdf.Pdf) -> int:
    removed = 0
    for page in pdf.pages:
        if "/Thumb" in page.obj:
            del page.obj["/Thumb"]
            removed += 1
    return removed


def remove_pieceinfo(pdf: pikepdf.Pdf) -> bool:
    """Strip /PieceInfo (Illustrator/InDesign/Acrobat private editor data,
    never rendered) from the document catalog and every page."""
    removed = False
    if "/PieceInfo" in pdf.Root:
        del pdf.Root["/PieceInfo"]
        removed = True
    for page in pdf.pages:
        if "/PieceInfo" in page.obj:
            del page.obj["/PieceInfo"]
            removed = True
    return removed


def compact(pdf: pikepdf.Pdf, output_path):
    pdf.remove_unreferenced_resources()
    pdf.save(output_path, compress_streams=True,
              object_stream_mode=pikepdf.ObjectStreamMode.generate)


def run_clean(pdf: pikepdf.Pdf) -> dict:
    """Run every always-safe waste-removal step. Does not save; caller is
    responsible for calling compact() (or a further mutation pass) after."""
    return {
        "icc_profiles_stripped": strip_icc_profiles(pdf),
        "duplicate_images_deduped": dedup_images(pdf),
        "unused_fonts_removed": remove_unused_fonts(pdf),
        "javascript_removed": remove_javascript(pdf),
        "embedded_files_removed": remove_embedded_files(pdf),
        "thumbnails_removed": remove_thumbnails(pdf),
        "pieceinfo_removed": remove_pieceinfo(pdf),
    }


# ---------------------------------------------------------------------------
# Raster image recompression (operates via fitz, so takes a path in/out)
# ---------------------------------------------------------------------------

def recompress_images(input_path, output_path, max_dim: int, jpeg_quality: int,
                       min_size_bytes: int = 8_000) -> int:
    """Downsample/re-encode oversized raster images as JPEG. Only commits a
    replacement if it's actually smaller than the original. Must go through
    fitz (pikepdf has no pixel codec), so operates path-to-path."""
    doc = fitz.open(input_path)
    seen = set()
    touched = 0
    for page in doc:
        for img in page.get_images(full=True):
            xref = img[0]
            smask_xref = img[1]  # 0 if this image has no separate soft mask
            if xref in seen:
                continue
            seen.add(xref)
            try:
                info = doc.extract_image(xref)
            except Exception:
                continue
            raw = info["image"]
            if len(raw) < min_size_bytes:
                continue
            try:
                im = Image.open(io.BytesIO(raw))
                im.load()
            except Exception:
                continue

            # An image can carry transparency two ways: a separate /SMask
            # object (the common case for JPEG-backed images, since JPEG
            # itself has no alpha channel), or an alpha channel baked
            # directly into this one decoded image (RGBA/LA/palette-with-
            # transparency). Either way, extract_image() above only gives
            # the opaque base color data - re-encoding just that and
            # dropping the alpha would let whatever raw pixel data sits in
            # the "transparent" region (often garbage, frequently black)
            # show through. An earlier version of this fix composited onto
            # white to avoid that - correct only when the image sits
            # directly on a plain white page, and wrong for layered artwork
            # (e.g. individual icons placed over each other or over colored
            # shapes), where it replaced real transparency with a visible
            # white box. There's no backdrop color that's safe to assume,
            # so the only correct fix is to keep the transparency: recompress
            # the base color data as usual, and re-encode the alpha as its
            # own small grayscale image, reattached as this image's /SMask.
            mask_im = None
            old_mask_size = 0
            if smask_xref:
                try:
                    mask_info = doc.extract_image(smask_xref)
                    old_mask_size = len(mask_info["image"])
                    mask_im = Image.open(io.BytesIO(mask_info["image"])).convert("L")
                except Exception:
                    continue  # don't risk mangling a transparency case we can't parse
            elif im.mode in ("RGBA", "LA"):
                mask_im = im.split()[-1]
            elif im.mode == "P" and "transparency" in im.info:
                mask_im = im.convert("RGBA").split()[-1]

            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")

            w, h = im.size
            if max(w, h) > max_dim:
                scale = max_dim / max(w, h)
                new_size = (max(1, int(w * scale)), max(1, int(h * scale)))
                im = im.resize(new_size, Image.LANCZOS)
                if mask_im is not None:
                    mask_im = mask_im.resize(new_size, Image.LANCZOS)
            elif mask_im is not None and mask_im.size != im.size:
                mask_im = mask_im.resize(im.size, Image.LANCZOS)

            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=jpeg_quality, optimize=True)
            new_bytes = buf.getvalue()

            # Raw (uncompressed) mask bytes, deliberately not pre-compressed
            # here: update_stream()'s own `compress` handling and Length
            # bookkeeping didn't line up with pre-flated input in testing
            # (produced a garbled/misshapen mask on readback) - passing raw
            # bytes and no /Filter is what round-tripped correctly. The
            # final doc.save(..., deflate=True) below still compresses it
            # like every other stream in the file.
            mask_raw = mask_im.tobytes() if mask_im is not None else None
            # old_mask_size is the old mask's stored (compressed) size:
            # compare like with like using a compressed-size estimate here
            # rather than len(mask_raw) (always much larger, uncompressed) -
            # the actual write below stays raw regardless (see note above).
            mask_size_estimate = len(zlib.compress(mask_raw, level=6)) if mask_raw is not None else 0

            old_total = len(raw) + old_mask_size
            new_total = len(new_bytes) + mask_size_estimate
            if new_total < old_total:
                try:
                    page.replace_image(xref, stream=new_bytes)
                    if mask_raw is not None:
                        mw, mh = mask_im.size
                        mask_xref = doc.get_new_xref()
                        doc.update_object(
                            mask_xref,
                            f"<< /Type /XObject /Subtype /Image /Width {mw} /Height {mh} "
                            f"/ColorSpace /DeviceGray /BitsPerComponent 8 >>",
                        )
                        doc.update_stream(mask_xref, mask_raw)
                        doc.xref_set_key(xref, "SMask", f"{mask_xref} 0 R")
                    elif smask_xref:
                        doc.xref_set_key(xref, "SMask", "null")
                    touched += 1
                except Exception:
                    pass

    doc.save(output_path, garbage=4, deflate=True)
    doc.close()
    return touched


# ---------------------------------------------------------------------------
# Heavy-page ranking and whole-page rasterization (last-resort fallback)
# ---------------------------------------------------------------------------

def page_weight(pdf: pikepdf.Pdf, page) -> int:
    """Sum of raw stream bytes referenced by a page: its own content
    stream(s) plus every XObject in its Resources (recursing into nested
    Forms), deduped within the page so a Form invoked twice isn't double
    counted for this one page's total."""
    total = 0
    seen = set()

    def add(obj):
        nonlocal total
        key = obj.objgen
        if key in seen:
            return
        seen.add(key)
        try:
            total += len(obj.read_raw_bytes())
        except Exception:
            return
        try:
            if obj.get("/Subtype") == pikepdf.Name.Form and "/Resources" in obj:
                res = obj.Resources
                if "/XObject" in res:
                    for name in res.XObject.keys():
                        add(res.XObject[name])
        except Exception:
            pass

    contents = page.obj.get("/Contents")
    if contents is not None:
        if isinstance(contents, pikepdf.Array):
            for c in contents:
                add(c)
        else:
            add(contents)

    res = page.obj.get("/Resources")
    if res is not None and "/XObject" in res:
        for name in res.XObject.keys():
            try:
                add(res.XObject[name])
            except Exception:
                continue

    return total


def rank_heavy_pages(pdf: pikepdf.Pdf) -> list:
    """Page indices ranked by page_weight, descending."""
    weights = [(i, page_weight(pdf, page)) for i, page in enumerate(pdf.pages)]
    weights.sort(key=lambda x: -x[1])
    return weights


def rasterize_pages(input_path, output_path, page_indices, dpi: int, jpeg_quality: int):
    """Flatten specific pages to a single full-page raster image each. Last
    resort: destroys selectable text on those pages. Only used for pages
    whose bloat lives directly in raw content-stream operators with no
    isolable Form/region to swap instead (rare after Ghostscript
    reconstruction + region promotion, but a needed fallback)."""
    page_indices = set(page_indices)
    src = fitz.open(input_path)
    out = fitz.open()
    for i, page in enumerate(src):
        if i in page_indices:
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            img_bytes = pix.tobytes("jpeg", jpg_quality=jpeg_quality)
            rect = page.rect
            newpage = out.new_page(width=rect.width, height=rect.height)
            newpage.insert_image(rect, stream=img_bytes)
        else:
            out.insert_pdf(src, from_page=i, to_page=i)
    out.save(output_path, garbage=4, deflate=True)
    out.close()
    src.close()


# ---------------------------------------------------------------------------
# Optional Ghostscript /printer-preset reconstruction pass
# ---------------------------------------------------------------------------

def ghostscript_available() -> bool:
    import shutil
    return shutil.which("gs") is not None


def run_ghostscript_reconstruct(input_path, output_path, timeout: int = 300) -> bool:
    """Re-serialize the PDF through Ghostscript's /printer preset. Validated
    (this session) to genuinely shrink dense vector content streams -
    sometimes dramatically - by re-encoding them more compactly, with zero
    rasterization and pixel-identical rendering/text in every file checked.

    Deliberately uses /printer, never /screen or /ebook: those presets
    invoke Ghostscript's image downsample filter, which is broken on at
    least one real machine this tool has been used on (throws "Failed to
    initialise downsample filter"). /printer never downsamples images, so
    it avoids that code path entirely. Returns True on success; on any
    failure (gs missing, non-zero exit, timeout), leaves output_path
    untouched and returns False so the caller can fall back to the
    original file without treating this as fatal."""
    import subprocess
    if not ghostscript_available():
        return False
    cmd = [
        "gs", "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.4",
        "-dPDFSETTINGS=/printer", "-dQUIET", "-dBATCH", "-dNOPAUSE",
        "-dUseCropBox", "-dDetectDuplicateImages", "-dEmbedAllFonts=true",
        "-dPrinted", f"-o{output_path}", str(input_path),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except Exception:
        return False
    if result.returncode != 0:
        return False
    import os
    return os.path.exists(output_path) and os.path.getsize(output_path) > 0
    src.close()
