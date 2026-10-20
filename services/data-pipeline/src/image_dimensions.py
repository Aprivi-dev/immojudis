"""Dimensions déclarées d'une image (JPEG, WebP, HEIC/HEIF), lues dans l'en-tête sans ouvrir l'image.

Le garde-fou d'allocation de ``information_agent_evidence`` refuse une image trop grande avant tout décodeur.
"""

from __future__ import annotations


def _jpeg_dimensions(content: bytes) -> tuple[int, int] | None:
    if len(content) < 4 or content[:2] != b"\xff\xd8":
        return None
    offset = 2
    while offset + 4 <= len(content):
        if content[offset] != 0xFF:
            offset += 1
            continue
        while offset < len(content) and content[offset] == 0xFF:
            offset += 1
        if offset >= len(content):
            return None
        marker = content[offset]
        offset += 1
        if marker in {0xD8, 0xD9}:
            continue
        if marker == 0xDA:
            return None
        if marker in range(0xD0, 0xD8):
            continue
        segment_length = int.from_bytes(content[offset : offset + 2], "big")
        if segment_length < 2 or offset + segment_length > len(content):
            return None
        # SOF markers carry precision, height and width after the length.
        if marker in {
            *range(0xC0, 0xC4),
            *range(0xC5, 0xC8),
            *range(0xC9, 0xCC),
            *range(0xCD, 0xD0),
        }:
            if segment_length < 7:
                return None
            height = int.from_bytes(content[offset + 3 : offset + 5], "big")
            width = int.from_bytes(content[offset + 5 : offset + 7], "big")
            return width, height
        offset += segment_length
    return None


def _webp_dimensions(content: bytes) -> tuple[int, int] | None:
    if len(content) < 16 or content[:4] != b"RIFF" or content[8:12] != b"WEBP":
        return None
    offset = 12
    while offset + 8 <= len(content):
        chunk_type = content[offset : offset + 4]
        chunk_size = int.from_bytes(content[offset + 4 : offset + 8], "little")
        payload_start = offset + 8
        payload_end = payload_start + chunk_size
        if payload_end > len(content):
            return None
        payload = content[payload_start:payload_end]
        if chunk_type == b"VP8X" and len(payload) >= 10:
            width = 1 + int.from_bytes(payload[4:7], "little")
            height = 1 + int.from_bytes(payload[7:10], "little")
            return width, height
        if chunk_type == b"VP8 " and len(payload) >= 10 and payload[3:6] == b"\x9d\x01\x2a":
            width = int.from_bytes(payload[6:8], "little") & 0x3FFF
            height = int.from_bytes(payload[8:10], "little") & 0x3FFF
            return width, height
        if chunk_type == b"VP8L" and len(payload) >= 5 and payload[0] == 0x2F:
            width = 1 + (payload[1] | ((payload[2] & 0x3F) << 8))
            height = 1 + ((payload[2] >> 6) | (payload[3] << 2) | ((payload[4] & 0x0F) << 10))
            return width, height
        offset = payload_end + (chunk_size & 1)
    return None


def _isobmff_dimensions(content: bytes) -> tuple[int, int] | None:
    # HEIC/HEIF stores the decoded dimensions in an ``ispe`` box. Parsing the
    # small header avoids opening the image before the allocation guard runs.
    marker = b"ispe"
    dimensions: tuple[int, int] | None = None
    search_from = 0
    while True:
        offset = content.find(marker, search_from)
        if offset < 0:
            return dimensions
        if offset + 16 > len(content):
            return None
        width = int.from_bytes(content[offset + 8 : offset + 12], "big")
        height = int.from_bytes(content[offset + 12 : offset + 16], "big")
        if width <= 0 or height <= 0:
            return None
        if dimensions is None:
            dimensions = (width, height)
        else:
            # A container may expose thumbnails and primary images. Guard the
            # largest declared dimensions before any decoder is opened.
            dimensions = (max(dimensions[0], width), max(dimensions[1], height))
        search_from = offset + len(marker)
