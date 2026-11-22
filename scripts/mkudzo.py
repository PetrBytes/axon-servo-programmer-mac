#!/usr/bin/env python3
"""Wrap a raw filesystem image (e.g. ISO9660) in a compressed UDIF .dmg (zlib = UDZO, bzip2 = UDBZ)."""
import base64
import bz2
import plistlib
import struct
import sys
import uuid
import zlib

SECTOR = 512
CHUNK_SECTORS = 2048  # 1 MiB chunks, same as hdiutil
ZLIB, BZIP2, ZERO, END = 0x80000005, 0x80000006, 0x00000000, 0xFFFFFFFF


def crc32_field(value):
    # checksum type 2 (CRC32), 32 bits, then 32 uint32 slots
    return struct.pack('>II', 2, 32) + struct.pack('>I', value) + b'\0' * 124


def main(src, dst, method='zlib'):
    raw = open(src, 'rb').read()
    if len(raw) % SECTOR:
        raw += b'\0' * (SECTOR - len(raw) % SECTOR)
    total = len(raw) // SECTOR

    out = bytearray()
    chunks = []
    for first in range(0, total, CHUNK_SECTORS):
        n = min(CHUNK_SECTORS, total - first)
        piece = raw[first * SECTOR:(first + n) * SECTOR]
        if piece.count(0) == len(piece):
            chunks.append((ZERO, first, n, len(out), 0))
            continue
        if method == 'bzip2':
            comp, typ = bz2.compress(piece, 9), BZIP2
        else:
            comp, typ = zlib.compress(piece, 9), ZLIB
        chunks.append((typ, first, n, len(out), len(comp)))
        out += comp
    data_len = len(out)
    data_crc = zlib.crc32(out) & 0xffffffff
    blk_crc = zlib.crc32(raw) & 0xffffffff

    mish = bytearray()
    mish += b'mish' + struct.pack('>I', 1)
    mish += struct.pack('>QQQ', 0, total, 0)
    mish += struct.pack('>II', CHUNK_SECTORS, 0)
    mish += b'\0' * 24
    mish += crc32_field(blk_crc)
    mish += struct.pack('>I', len(chunks) + 1)
    for typ, first, n, off, ln in chunks:
        mish += struct.pack('>IIQQQQ', typ, 0, first, n, off, ln)
    mish += struct.pack('>IIQQQQ', END, 0, total, 0, data_len, 0)
    assert len(mish) == 204 + 40 * (len(chunks) + 1)

    plist = {
        'resource-fork': {
            'blkx': [{
                'Attributes': '0x0050',
                'CFName': 'whole disk (Apple_ISO : 0)',
                'Data': bytes(mish),
                'ID': '0',
                'Name': 'whole disk (Apple_ISO : 0)',
            }],
        },
    }
    xml = plistlib.dumps(plist, fmt=plistlib.FMT_XML)
    xml_off = len(out)
    out += xml

    master = zlib.crc32(struct.pack('>I', blk_crc)) & 0xffffffff
    koly = bytearray()
    koly += b'koly' + struct.pack('>III', 4, 512, 1)
    koly += struct.pack('>QQQQQ', 0, 0, data_len, 0, 0)
    koly += struct.pack('>II', 1, 1)
    koly += uuid.uuid4().bytes
    koly += crc32_field(data_crc)
    koly += struct.pack('>QQ', xml_off, len(xml))
    koly += b'\0' * 120
    koly += crc32_field(master)
    koly += struct.pack('>IQ', 1, total)
    koly += b'\0' * 12
    assert len(koly) == 512, len(koly)
    out += koly
    open(dst, 'wb').write(out)
    print(f'{dst}: {len(out)/1e6:.1f} MB ({total} sectors, {len(chunks)} chunks, {len(raw)/1e6:.1f} MB raw)')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'zlib')
