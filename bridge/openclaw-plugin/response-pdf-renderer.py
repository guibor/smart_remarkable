#!/usr/bin/python3
"""Deterministic plain-text response PDF rendering with Cairo and Pango."""

from __future__ import annotations

import json
import os
import platform
import re
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

import cairo
import gi

gi.require_version("Pango", "1.0")
gi.require_version("PangoCairo", "1.0")
from gi.repository import Pango, PangoCairo  # noqa: E402


PROTOCOL = "response-pdf-pango-v1"
VERSION_RECEIPT = (
    "smart-remarkable-pango-pdf-v1 "
    "python=3.10.12 pycairo=1.20.1 cairo=1.16.0 "
    "pygobject=3.42.1 pango=1.50.6"
)
EXPECTED_VERSIONS = (
    platform.python_version(),
    cairo.version,
    cairo.cairo_version_string(),
    gi.__version__,
    Pango.version_string(),
)
PINNED_VERSIONS = ("3.10.12", "1.20.1", "1.16.0", "3.42.1", "1.50.6")

A4_WIDTH_PT = 595.275590551
A4_HEIGHT_PT = 841.88976378
MARGIN_LEFT_PT = 54.0
MARGIN_RIGHT_PT = 54.0
CONTENT_TOP_PT = 70.0
CONTENT_BOTTOM_PT = 58.0
HEADER_Y_PT = 25.0
FOOTER_Y_PT = 818.0
BODY_FONT = "DejaVu Sans 11.5"
HEADING_FONT = "DejaVu Sans Bold 14"
TITLE_FONT = "DejaVu Sans Bold 20"
RUNNING_FONT = "DejaVu Sans 8.5"
HEBREW_FONT_FAMILY = "FreeSans"
FIXED_PDF_DATE = "2000-01-01T00:00:00Z"
MAX_RECEIVED_TEXT_BYTES = 2_048
MAX_RESPONSE_TEXT_BYTES = 32_256
MAX_COMBINED_TEXT_BYTES = MAX_RECEIVED_TEXT_BYTES + MAX_RESPONSE_TEXT_BYTES
MAX_COMBINED_LINE_BREAKS = 512
MAX_INPUT_BYTES = 128 * 1024
MAX_PDF_BYTES = 32 * 1024 * 1024
MAX_PAGES = 64
LINE_GAP_PT = 2.5
PARAGRAPH_GAP_PT = 5.5
BLANK_LINE_PT = 9.0
INPUT_KEYS = frozenset(
    {"protocol", "received_text", "request_id", "response_text"}
)
REQUEST_ID_PATTERN = re.compile(
    r"^smart-remarkable-[A-Za-z0-9][A-Za-z0-9._:-]{0,110}$"
)
BIDI_CONTROLS = frozenset(
    [0x061C, 0x200E, 0x200F, *range(0x202A, 0x202F), *range(0x2066, 0x206A)]
)


def fail(message: str) -> ValueError:
    return ValueError(message)


def assert_versions() -> None:
    if EXPECTED_VERSIONS != PINNED_VERSIONS:
        raise RuntimeError("Response PDF renderer dependency identity drifted")


def same_file(left: os.stat_result, right: os.stat_result) -> bool:
    return (
        left.st_dev == right.st_dev
        and left.st_ino == right.st_ino
        and left.st_uid == right.st_uid
        and stat.S_IFMT(left.st_mode) == stat.S_IFMT(right.st_mode)
    )


def assert_private_regular_file(
    status: os.stat_result,
    *,
    expected_uid: int,
    label: str,
) -> None:
    if (
        not stat.S_ISREG(status.st_mode)
        or status.st_uid != expected_uid
        or stat.S_IMODE(status.st_mode) != 0o600
        or status.st_nlink != 1
    ):
        raise fail(f"{label} must be a private owned regular file")


def read_stable_input(input_path: Path) -> dict[str, object]:
    expected_uid = os.getuid()
    descriptor = os.open(input_path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        assert_private_regular_file(
            before, expected_uid=expected_uid, label="Response PDF input"
        )
        if before.st_size <= 0 or before.st_size > MAX_INPUT_BYTES:
            raise fail("Response PDF input has an invalid size")
        chunks: list[bytes] = []
        total = 0
        while total <= MAX_INPUT_BYTES:
            chunk = os.read(descriptor, min(64 * 1024, MAX_INPUT_BYTES + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        after = os.fstat(descriptor)
        path_status = os.lstat(input_path)
        if (
            total != before.st_size
            or total > MAX_INPUT_BYTES
            or not same_file(before, after)
            or not same_file(after, path_status)
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
            or before.st_ctime_ns != after.st_ctime_ns
        ):
            raise fail("Response PDF input changed during validation")
    finally:
        os.close(descriptor)

    try:
        decoded = b"".join(chunks).decode("utf-8", errors="strict")
        payload = json.loads(decoded)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise fail("Response PDF input must be strict UTF-8 JSON") from error
    if not isinstance(payload, dict) or set(payload) != INPUT_KEYS:
        raise fail("Response PDF input has an invalid shape")
    return payload


def validate_text(value: object, label: str, maximum_bytes: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise fail(f"{label} must be non-empty text")
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as error:
        raise fail(f"{label} must be well-formed UTF-8 text") from error
    if len(encoded) > maximum_bytes:
        raise fail(f"{label} exceeds its byte bound")
    for character in value:
        codepoint = ord(character)
        if (
            (codepoint < 0x20 and character != "\n")
            or 0x7F <= codepoint <= 0x9F
            or codepoint in BIDI_CONTROLS
        ):
            raise fail(f"{label} contains a forbidden control character")
    return value


def count_line_breaks(value: str) -> int:
    return value.count("\n") + value.count("\u2028") + value.count("\u2029")


@dataclass(frozen=True)
class RenderInput:
    request_id: str
    received_text: str
    response_text: str


def validate_input(payload: dict[str, object]) -> RenderInput:
    if payload["protocol"] != PROTOCOL:
        raise fail("Response PDF protocol does not match")
    request_id = payload["request_id"]
    if not isinstance(request_id, str) or not REQUEST_ID_PATTERN.fullmatch(request_id):
        raise fail("Response PDF request ID is invalid")
    received_text = validate_text(
        payload["received_text"], "received_text", MAX_RECEIVED_TEXT_BYTES
    )
    response_text = validate_text(
        payload["response_text"], "response_text", MAX_RESPONSE_TEXT_BYTES
    )
    if (
        len(received_text.encode("utf-8")) + len(response_text.encode("utf-8"))
        > MAX_COMBINED_TEXT_BYTES
        or count_line_breaks(received_text) + count_line_breaks(response_text)
        > MAX_COMBINED_LINE_BREAKS
    ):
        raise fail("Response PDF text exceeds the combined complexity bound")
    return RenderInput(
        request_id=request_id,
        received_text=received_text,
        response_text=response_text,
    )


def font_description(specification: str) -> Pango.FontDescription:
    description = Pango.FontDescription.from_string(specification)
    if description is None:
        raise RuntimeError("Pango rejected a fixed font description")
    return description


def is_hebrew_character(character: str) -> bool:
    codepoint = ord(character)
    return 0x0590 <= codepoint <= 0x05FF or 0xFB1D <= codepoint <= 0xFB4F


def add_hebrew_font_attributes(text: str, attributes: Pango.AttrList) -> None:
    byte_offset = 0
    run_start: int | None = None
    for character in text:
        next_offset = byte_offset + len(character.encode("utf-8"))
        if is_hebrew_character(character):
            if run_start is None:
                run_start = byte_offset
        elif run_start is not None:
            attribute = Pango.attr_family_new(HEBREW_FONT_FAMILY)
            attribute.start_index = run_start
            attribute.end_index = byte_offset
            attributes.insert(attribute)
            run_start = None
        byte_offset = next_offset
    if run_start is not None:
        attribute = Pango.attr_family_new(HEBREW_FONT_FAMILY)
        attribute.start_index = run_start
        attribute.end_index = byte_offset
        attributes.insert(attribute)


@dataclass(frozen=True)
class LayoutLine:
    line: Pango.LayoutLine
    logical_x: float
    logical_y: float
    width: float
    height: float
    rtl: bool

    @property
    def advance(self) -> float:
        return self.height + LINE_GAP_PT


class PdfFlow:
    def __init__(self, output: BinaryIO) -> None:
        self.surface = cairo.PDFSurface(output, A4_WIDTH_PT, A4_HEIGHT_PT)
        self.surface.restrict_to_version(cairo.PDF_VERSION_1_5)
        self.surface.set_metadata(cairo.PDF_METADATA_TITLE, "OpenClaw response")
        self.surface.set_metadata(cairo.PDF_METADATA_AUTHOR, "OpenClaw")
        self.surface.set_metadata(
            cairo.PDF_METADATA_SUBJECT, "Response returned to reMarkable"
        )
        self.surface.set_metadata(
            cairo.PDF_METADATA_KEYWORDS, "OpenClaw,reMarkable,response"
        )
        self.surface.set_metadata(
            cairo.PDF_METADATA_CREATOR, "smart_remarkable response renderer"
        )
        self.surface.set_metadata(cairo.PDF_METADATA_CREATE_DATE, FIXED_PDF_DATE)
        self.surface.set_metadata(cairo.PDF_METADATA_MOD_DATE, FIXED_PDF_DATE)
        self.context = cairo.Context(self.surface)
        self.page_number = 0
        self.y = CONTENT_TOP_PT
        self.closed = False
        self._begin_page()

    @property
    def content_width(self) -> float:
        return A4_WIDTH_PT - MARGIN_LEFT_PT - MARGIN_RIGHT_PT

    @property
    def content_height(self) -> float:
        return A4_HEIGHT_PT - CONTENT_TOP_PT - CONTENT_BOTTOM_PT

    @property
    def available_height(self) -> float:
        return A4_HEIGHT_PT - CONTENT_BOTTOM_PT - self.y

    def _make_layout(
        self, text: str, font: str, width: float | None = None
    ) -> Pango.Layout:
        layout = PangoCairo.create_layout(self.context)
        layout.set_font_description(font_description(font))
        PangoCairo.context_set_resolution(layout.get_context(), 72.0)
        layout.set_text(text, -1)
        layout.set_auto_dir(True)
        layout.set_wrap(Pango.WrapMode.WORD_CHAR)
        layout.set_ellipsize(Pango.EllipsizeMode.NONE)
        attributes = Pango.AttrList()
        fallback = Pango.attr_fallback_new(False)
        fallback.start_index = 0
        fallback.end_index = 0xFFFFFFFF
        attributes.insert(fallback)
        add_hebrew_font_attributes(text, attributes)
        layout.set_attributes(attributes)
        if width is not None:
            layout.set_width(round(width * Pango.SCALE))
        if layout.get_unknown_glyphs_count() != 0:
            raise RuntimeError("Response PDF text contains an unavailable glyph")
        return layout

    def _draw_running_text(
        self, text: str, x: float, y: float, *, align_right: bool = False
    ) -> None:
        layout = self._make_layout(text, RUNNING_FONT)
        logical = layout.get_extents()[1]
        width = logical.width / Pango.SCALE
        draw_x = x - width if align_right else x
        self.context.move_to(draw_x, y)
        self.context.set_source_rgb(0.25, 0.25, 0.25)
        PangoCairo.show_layout(self.context, layout)

    def _begin_page(self) -> None:
        self.page_number += 1
        if self.page_number > MAX_PAGES:
            raise RuntimeError("Response PDF exceeded the page bound")
        self.context.save()
        self.context.set_source_rgb(1.0, 1.0, 1.0)
        self.context.paint()
        self.context.restore()
        self._draw_running_text(
            "OpenClaw - reMarkable response", MARGIN_LEFT_PT, HEADER_Y_PT
        )
        self._draw_running_text(
            f"Page {self.page_number}",
            A4_WIDTH_PT - MARGIN_RIGHT_PT,
            FOOTER_Y_PT,
            align_right=True,
        )
        self.context.set_source_rgb(0.0, 0.0, 0.0)
        self.y = CONTENT_TOP_PT

    def _next_page(self) -> None:
        self.surface.show_page()
        self._begin_page()

    def _ensure_space(self, required_height: float) -> None:
        if required_height > self.content_height:
            raise RuntimeError("Response PDF element exceeds one page")
        if required_height > self.available_height:
            self._next_page()

    def _layout_lines(self, text: str, font: str) -> tuple[Pango.Layout, list[LayoutLine]]:
        layout = self._make_layout(text, font, self.content_width)
        output: list[LayoutLine] = []
        for line in layout.get_lines_readonly():
            logical = line.get_extents()[1]
            resolved = line.get_resolved_direction()
            output.append(
                LayoutLine(
                    line=line,
                    logical_x=logical.x / Pango.SCALE,
                    logical_y=logical.y / Pango.SCALE,
                    width=logical.width / Pango.SCALE,
                    height=max(logical.height / Pango.SCALE, 13.0),
                    rtl=resolved in (Pango.Direction.RTL, Pango.Direction.WEAK_RTL),
                )
            )
        if not output:
            raise RuntimeError("Pango produced no layout lines")
        return layout, output

    def _draw_line(self, line: LayoutLine) -> None:
        left_edge = (
            A4_WIDTH_PT - MARGIN_RIGHT_PT - line.width
            if line.rtl
            else MARGIN_LEFT_PT
        )
        self.context.move_to(left_edge - line.logical_x, self.y - line.logical_y)
        self.context.set_source_rgb(0.0, 0.0, 0.0)
        PangoCairo.show_layout_line(self.context, line.line)
        self.y += line.advance

    def draw_title(self, text: str) -> None:
        layout = self._make_layout(text, TITLE_FONT, self.content_width)
        height = max(layout.get_extents()[1].height / Pango.SCALE, 24.0)
        self._ensure_space(height + 13.0)
        self.context.move_to(MARGIN_LEFT_PT, self.y)
        self.context.set_source_rgb(0.0, 0.0, 0.0)
        PangoCairo.show_layout(self.context, layout)
        self.y += height + 13.0

    def draw_heading(self, text: str) -> None:
        layout = self._make_layout(text, HEADING_FONT, self.content_width)
        height = max(layout.get_extents()[1].height / Pango.SCALE, 17.0)
        self._ensure_space(height + 8.0 + (2 * (13.0 + LINE_GAP_PT)))
        self.context.move_to(MARGIN_LEFT_PT, self.y)
        self.context.set_source_rgb(0.0, 0.0, 0.0)
        PangoCairo.show_layout(self.context, layout)
        self.y += height + 8.0

    def _fit_count(self, lines: list[LayoutLine], start: int) -> int:
        used = 0.0
        count = 0
        for line in lines[start:]:
            if used + line.advance > self.available_height:
                break
            used += line.advance
            count += 1
        return count

    def draw_plain_text(self, text: str) -> None:
        paragraphs = text.split("\n")
        for paragraph_index, paragraph in enumerate(paragraphs):
            if paragraph == "":
                self._ensure_space(BLANK_LINE_PT)
                self.y += BLANK_LINE_PT
                continue

            layout, lines = self._layout_lines(paragraph, BODY_FONT)
            paragraph_height = sum(line.advance for line in lines)
            if paragraph_height <= self.content_height:
                self._ensure_space(paragraph_height)
                for line in lines:
                    self._draw_line(line)
            else:
                index = 0
                while index < len(lines):
                    fit = self._fit_count(lines, index)
                    remaining = len(lines) - index
                    if fit < min(2, remaining) and self.y > CONTENT_TOP_PT:
                        self._next_page()
                        continue
                    if fit == 0:
                        raise RuntimeError("Response PDF line does not fit on a page")
                    if remaining - fit == 1 and fit > 1:
                        fit -= 1
                    for line in lines[index : index + fit]:
                        self._draw_line(line)
                    index += fit
                    if index < len(lines):
                        self._next_page()

            if paragraph_index != len(paragraphs) - 1:
                self._ensure_space(PARAGRAPH_GAP_PT)
                self.y += PARAGRAPH_GAP_PT

    def finish(self) -> int:
        if self.closed:
            raise RuntimeError("Response PDF flow is already closed")
        self.surface.flush()
        self.surface.finish()
        self.closed = True
        return self.page_number

    def abort(self) -> None:
        if self.closed:
            return
        try:
            self.surface.finish()
        finally:
            self.closed = True


def open_private_output(output_path: Path) -> tuple[int, os.stat_result]:
    descriptor = os.open(output_path, os.O_WRONLY | os.O_NOFOLLOW)
    try:
        status = os.fstat(descriptor)
        assert_private_regular_file(
            status, expected_uid=os.getuid(), label="Response PDF output"
        )
        if status.st_size != 0:
            raise fail("Response PDF output must be empty")
        return descriptor, status
    except Exception:
        os.close(descriptor)
        raise


def verify_output(
    output_path: Path,
    descriptor: int,
    before: os.stat_result,
) -> int:
    os.fsync(descriptor)
    after = os.fstat(descriptor)
    path_status = os.lstat(output_path)
    assert_private_regular_file(
        after, expected_uid=os.getuid(), label="Response PDF output"
    )
    if (
        not same_file(before, after)
        or not same_file(after, path_status)
        or after.st_size < 16
        or after.st_size > MAX_PDF_BYTES
    ):
        raise fail("Response PDF output failed stable-file validation")
    return after.st_size


def render(input_path: Path, output_path: Path) -> dict[str, object]:
    assert_versions()
    payload = validate_input(read_stable_input(input_path))
    descriptor, before = open_private_output(output_path)
    flow: PdfFlow | None = None
    try:
        with os.fdopen(descriptor, "wb", buffering=0, closefd=False) as output:
            flow = PdfFlow(output)
            flow.draw_title("OpenClaw response")
            flow.draw_heading("Received selection")
            flow.draw_plain_text(payload.received_text)
            flow.draw_heading("OpenClaw response")
            flow.draw_plain_text(payload.response_text)
            pages = flow.finish()
            output.flush()
        size = verify_output(output_path, descriptor, before)
        return {
            "bytes": size,
            "pages": pages,
            "renderer": PROTOCOL,
            "unknown_glyphs": 0,
        }
    except Exception:
        if flow is not None:
            try:
                flow.abort()
            except Exception:
                pass
        raise
    finally:
        os.close(descriptor)


def main() -> int:
    if sys.argv == [sys.argv[0], "--version"]:
        assert_versions()
        print(VERSION_RECEIPT)
        return 0
    if len(sys.argv) != 4 or sys.argv[1] != "--render":
        raise fail("Response PDF renderer received invalid arguments")
    input_path = Path(sys.argv[2])
    output_path = Path(sys.argv[3])
    if not input_path.is_absolute() or not output_path.is_absolute():
        raise fail("Response PDF renderer paths must be absolute")
    receipt = render(input_path, output_path)
    print(json.dumps(receipt, ensure_ascii=True, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
