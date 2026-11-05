"""chains/ton_cell.py — the minimal TON cell model + BOC serialization the TON
adapter (chains/ton.py) and the golden-vector tests depend on. Byte-identical
logic to the extension's chains/ton-cell.js (the canonical engine).

Standard cell representation (what gets sha256'd):
    d1 ++ d2 ++ augmented(bits) ++ (per ref: depth BE16) ++ (per ref: hash32)
d1 = refs + 8*is_exotic + 32*level_mask (ordinary level-0: d1 = refs); d2 =
floor(bits/8)+ceil(bits/8); bit data zero-padded to a byte boundary WITH the TON
completion tag (a 1 bit then 0s) iff bits % 8 != 0. BOC mirrors @ton/core.

NOT post-quantum — TON is Ed25519 (classical). Ported from chains/ton-cell.js.
"""
from __future__ import annotations

import base64 as _b64

from .. import crypto as K

SUBWALLET_ID = 698983191
TAG_BOUNCEABLE = 0x11
TAG_NONBOUNCEABLE = 0x51
TAG_TEST = 0x80


# ---- base64 (std + url) ----------------------------------------------------
def from_base64(s: str) -> bytes:
    t = str(s).replace("-", "+").replace("_", "/")
    t += "=" * ((4 - len(t) % 4) % 4)
    return _b64.b64decode(t)


def to_base64(data: bytes, url_safe: bool = False) -> str:
    b = _b64.b64encode(bytes(data)).decode("ascii")
    return b.replace("+", "-").replace("/", "_") if url_safe else b


# ---- CRC-16/CCITT (XModem: poly 0x1021, init 0x0000) -----------------------
def crc16_ccitt(data: bytes) -> bytes:
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if (crc & 0x8000) else (crc << 1)
            crc &= 0xFFFF
    return bytes([(crc >> 8) & 0xFF, crc & 0xFF])


# ---- CRC-32C (Castagnoli, reflected poly 0x82f63b78), little-endian out -----
def crc32c(data: bytes) -> bytes:
    crc = 0xFFFFFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc >> 1) ^ 0x82F63B78) if (crc & 1) else (crc >> 1)
    crc = (crc ^ 0xFFFFFFFF) & 0xFFFFFFFF
    return bytes([crc & 0xFF, (crc >> 8) & 0xFF, (crc >> 16) & 0xFF, (crc >> 24) & 0xFF])


def _pack_bits(bit_arr):
    n = len(bit_arr)
    out = bytearray((n + 7) // 8)
    for i in range(n):
        if bit_arr[i]:
            out[i >> 3] |= 0x80 >> (i & 7)
    return bytes(out)


class Cell:
    def __init__(self, bits_packed: bytes, bit_len: int, refs=None, is_exotic: bool = False):
        self.bits_packed = bits_packed
        self.bit_len = bit_len
        self.refs = refs or []
        self.is_exotic = is_exotic
        self._hash = None
        self._depth = None

    def augmented_bytes(self) -> bytes:
        byte_len = (self.bit_len + 7) // 8
        out = bytearray(self.bits_packed[:byte_len])
        if len(out) < byte_len:
            out.extend(b"\x00" * (byte_len - len(out)))
        rem = self.bit_len % 8
        if rem != 0:
            out[byte_len - 1] |= 0x80 >> rem
        return bytes(out)

    def depth(self) -> int:
        if self._depth is None:
            d = 0
            for r in self.refs:
                rd = r.depth() + 1
                if rd > d:
                    d = rd
            self._depth = d
        return self._depth

    def repr_bytes(self) -> bytes:
        d1 = len(self.refs) + (8 if self.is_exotic else 0)
        b = self.bit_len
        d2 = (b // 8) + ((b + 7) // 8)
        out = bytearray([d1, d2])
        out.extend(self.augmented_bytes())
        for r in self.refs:
            dep = r.depth()
            out.append((dep >> 8) & 0xFF)
            out.append(dep & 0xFF)
        for r in self.refs:
            out.extend(r.hash())
        return bytes(out)

    def hash(self) -> bytes:
        if self._hash is None:
            self._hash = K.sha256(self.repr_bytes())
        return self._hash

    def hash_hex(self) -> str:
        return self.hash().hex()

    def to_boc(self, idx: bool = False, crc32: bool = True) -> bytes:
        return serialize_boc(self, idx=idx, crc32=crc32)


def cell_hash(cell: Cell) -> bytes:
    return cell.hash()


class Builder:
    def __init__(self):
        self.bits = []
        self.refs = []

    def available_bits(self) -> int:
        return 1023 - len(self.bits)

    @property
    def refs_count(self) -> int:
        return len(self.refs)

    def store_bit(self, b):
        self.bits.append(1 if b else 0)
        return self

    def store_uint(self, value, nbits: int):
        v = int(value)
        if v < 0:
            raise ValueError("store_uint negative")
        for i in range(nbits - 1, -1, -1):
            self.bits.append((v >> i) & 1)
        return self

    def store_int(self, value: int, nbits: int):
        v = int(value)
        if v < 0:
            v += (1 << nbits)
        for i in range(nbits - 1, -1, -1):
            self.bits.append((v >> i) & 1)
        return self

    def store_bytes(self, data):
        for byte in data:
            for b in range(7, -1, -1):
                self.bits.append((byte >> b) & 1)
        return self

    store_buffer = store_bytes

    def store_coins(self, amount):
        v = int(amount)
        if v < 0:
            raise ValueError("store_coins negative")
        if v == 0:
            return self.store_uint(0, 4)
        hex_s = format(v, "x")
        if len(hex_s) % 2:
            hex_s = "0" + hex_s
        nbytes = len(hex_s) // 2
        self.store_uint(nbytes, 4)
        for i in range(nbytes):
            self.store_uint(int(hex_s[i * 2:i * 2 + 2], 16), 8)
        return self

    def store_address(self, addr):
        # addr: None -> addr_none$00 ; {"workchain", "hash"} -> addr_std$10
        if addr is None:
            return self.store_uint(0, 2)
        self.store_uint(2, 2)
        self.store_bit(0)
        self.store_int(addr["workchain"], 8)
        self.store_bytes(addr["hash"])
        return self

    def store_ref(self, cell: Cell):
        if len(self.refs) >= 4:
            raise ValueError("store_ref: too many refs")
        self.refs.append(cell)
        return self

    def store_maybe_ref(self, cell):
        if cell is not None:
            self.store_bit(1)
            self.store_ref(cell)
        else:
            self.store_bit(0)
        return self

    def store_slice(self, cell: Cell):
        for i in range(cell.bit_len):
            self.bits.append((cell.bits_packed[i >> 3] >> (7 - (i & 7))) & 1)
        for r in cell.refs:
            self.store_ref(r)
        return self

    store_builder = store_slice

    def end_cell(self) -> Cell:
        if len(self.bits) > 1023:
            raise ValueError(f"cell overflow: {len(self.bits)} bits")
        return Cell(_pack_bits(self.bits), len(self.bits), list(self.refs), False)


def begin_cell() -> Builder:
    return Builder()


# ---- BOC serialization (byte-identical to @ton/core serialize_boc) ----------
def _topological_sort(root: Cell):
    perm = set()
    temp = set()
    sorted_cells = []

    def visit(cell: Cell):
        h = cell.hash_hex()
        if h in perm:
            return
        if h in temp:
            raise ValueError("ton-cell: not a DAG")
        temp.add(h)
        for i in range(len(cell.refs) - 1, -1, -1):
            visit(cell.refs[i])
        sorted_cells.append(cell)
        temp.discard(h)
        perm.add(h)

    visit(root)
    ordered = list(reversed(sorted_cells))
    index_of = {cell.hash_hex(): i for i, cell in enumerate(ordered)}
    return [(cell, [index_of[r.hash_hex()] for r in cell.refs]) for cell in ordered]


def _bits_for_number(n: int) -> int:
    return 0 if n == 0 else n.bit_length()


def serialize_boc(root: Cell, idx: bool = False, crc32: bool = True) -> bytes:
    all_cells = _topological_sort(root)
    cells_num = len(all_cells)
    size_bytes = max((_bits_for_number(cells_num) + 7) // 8, 1)
    total_cell_size = 0
    index = []
    for cell, ref_idx in all_cells:
        sz = 2 + ((cell.bit_len + 7) // 8) + len(ref_idx) * size_bytes
        total_cell_size += sz
        index.append(total_cell_size)
    off_bytes = max((_bits_for_number(total_cell_size) + 7) // 8, 1)

    out = bytearray()

    def push_uint(val, nbytes):
        for i in range(nbytes - 1, -1, -1):
            out.append((val >> (8 * i)) & 0xFF)

    out.extend(b"\xb5\xee\x9c\x72")
    out.append(((1 if idx else 0) << 7) | ((1 if crc32 else 0) << 6) | (size_bytes & 7))
    out.append(off_bytes & 0xFF)
    push_uint(cells_num, size_bytes)
    push_uint(1, size_bytes)  # roots
    push_uint(0, size_bytes)  # absent
    push_uint(total_cell_size, off_bytes)
    push_uint(0, size_bytes)  # root index 0
    if idx:
        for i in range(cells_num):
            push_uint(index[i], off_bytes)
    for cell, ref_idx in all_cells:
        d1 = len(cell.refs) + (8 if cell.is_exotic else 0)
        b = cell.bit_len
        d2 = (b // 8) + ((b + 7) // 8)
        out.append(d1)
        out.append(d2)
        out.extend(cell.augmented_bytes())
        for ri in ref_idx:
            push_uint(ri, size_bytes)
    data = bytes(out)
    if crc32:
        data = data + crc32c(data)
    return data


# ---- BOC deserialization (one-root; enough to load the v4R2 code cell) ------
def parse_boc(src: bytes):
    o = [0]

    def u(n):
        v = 0
        for _ in range(n):
            v = (v * 256) + src[o[0]]
            o[0] += 1
        return v

    magic = u(4)
    has_idx = has_crc = False
    if magic == 0xB5EE9C72:
        flags = src[o[0]]
        o[0] += 1
        has_idx = bool(flags & 0x80)
        has_crc = bool(flags & 0x40)
        size_bytes = flags & 7
        off_bytes = src[o[0]]
        o[0] += 1
    elif magic in (0x68FF65F3, 0xACC3A728):
        size_bytes = src[o[0]]
        o[0] += 1
        off_bytes = src[o[0]]
        o[0] += 1
        has_idx = True
        has_crc = magic == 0xACC3A728
    else:
        raise ValueError("ton-cell: bad BOC magic")
    cells = u(size_bytes)
    roots = u(size_bytes)
    u(size_bytes)  # absent
    total_cell_size = u(off_bytes)
    root_list = [u(size_bytes) for _ in range(roots)]
    if has_idx:
        o[0] += cells * off_bytes
    cell_data = src[o[0]:o[0] + total_cell_size]
    o[0] += total_cell_size

    p = [0]

    def u2(n):
        v = 0
        for _ in range(n):
            v = v * 256 + cell_data[p[0]]
            p[0] += 1
        return v

    raw = []
    for _ in range(cells):
        d1 = cell_data[p[0]]
        p[0] += 1
        d2 = cell_data[p[0]]
        p[0] += 1
        refs_count = d1 & 7
        data_bytes = (d2 + 1) // 2  # ceil(d2/2)
        padded = (d2 & 1) == 1
        chunk = bytes(cell_data[p[0]:p[0] + data_bytes])
        p[0] += data_bytes
        bit_len = data_bytes * 8
        if padded and data_bytes > 0:
            last = chunk[data_bytes - 1]
            for b in range(8):
                if (last >> b) & 1:
                    bit_len = data_bytes * 8 - b - 1
                    break
        ref_idx = [u2(size_bytes) for _ in range(refs_count)]
        raw.append((d1, chunk, bit_len, ref_idx))

    built = [None] * cells
    for i in range(cells - 1, -1, -1):
        d1, chunk, bit_len, ref_idx = raw[i]
        refs = [built[ri] for ri in ref_idx]
        built[i] = Cell(chunk, bit_len, refs, bool(d1 & 8))
    return [built[ri] for ri in root_list]


def deserialize_boc(src: bytes):
    return parse_boc(src)


# ---- v4R2 wallet code (fixed constant; its hash is pinned by the vector) ----
V4R2_CODE_BASE64 = (
    "te6cckECFAEAAtQAART/APSkE/S88sgLAQIBIAIPAgFIAwYC5tAB0NMDIXGwkl8E4CLXScEg"
    "kl8E4ALTHyGCEHBsdWe9IoIQZHN0cr2wkl8F4AP6QDAg+kQByMoHy//J0O1E0IEBQNch9AQw"
    "XIEBCPQKb6Exs5JfB+AF0z/IJYIQcGx1Z7qSODDjDQOCEGRzdHK6kl8G4w0EBQB4AfoA9AQw"
    "+CdvIjBQCqEhvvLgUIIQcGx1Z4MesXCAGFAEywUmzxZY+gIZ9ADLaRfLH1Jgyz8gyYBA+wAG"
    "AIpQBIEBCPRZMO1E0IEBQNcgyAHPFvQAye1UAXKwjiOCEGRzdHKDHrFwgBhQBcsFUAPPFiP6"
    "AhPLassfyz/JgED7AJJfA+ICASAHDgIBIAgNAgFYCQoAPbKd+1E0IEBQNch9AQwAsjKB8v/"
    "ydABgQEI9ApvoTGACASALDAAZrc52omhAIGuQ64X/wAAZrx32omhAEGuQ64WPwAARuMl+1E"
    "0NcLH4AFm9JCtvaiaECAoGuQ+gIYRw1AgIR6STfSmRDOaQPp/5g3gSgBt4EBSJhxWfMYQE+"
    "PKDCNcYINMf0x/THwL4I7vyZO1E0NMf0x/T//QE0VFDuvKhUVG68qIF+QFUEGT5EPKj+AAk"
    "pMjLH1JAyx9SMMv/UhD0AMntVPgPAdMHIcAAn2xRkyDXSpbTB9QC+wDoMOAhwAHjACHAAuMA"
    "AcADkTDjDQOkyMsfEssfy/8QERITAG7SB/oA1NQi+QAFyMoHFcv/ydB3dIAYyMsFywIizxZQ"
    "BfoCFMtrEszMyXP7AMhAFIEBCPRR8qcCAHCBAQjXGPoA0z/IVCBHgQEI9FHyp4IQbm90ZXB0"
    "gBjIywXLAlAGzxZQBPoCFMtqEssfyz/Jc/sAAgBsgQEI1xj6ANM/MFIkgQEI9Fnyp4IQZHN0"
    "cnB0gBjIywXLAlAFzxZQA/oCE8tqyx8Syz/Jc/sAAAr0AMntVAj45Sg="
)

_code_cell = None


def v4r2_code_cell() -> Cell:
    global _code_cell
    if _code_cell is None:
        _code_cell = parse_boc(from_base64(V4R2_CODE_BASE64))[0]
    return _code_cell


def v4r2_data_cell(pub_key32: bytes, subwallet: int = SUBWALLET_ID) -> Cell:
    return (begin_cell()
            .store_uint(0, 32)
            .store_uint(subwallet, 32)
            .store_buffer(pub_key32)
            .store_bit(0)
            .end_cell())


def v4r2_state_init(pub_key32: bytes, subwallet: int = SUBWALLET_ID) -> Cell:
    code = v4r2_code_cell()
    data = v4r2_data_cell(pub_key32, subwallet)
    return (begin_cell()
            .store_uint(0, 2)
            .store_bit(1).store_ref(code)
            .store_bit(1).store_ref(data)
            .store_bit(0)
            .end_cell())


# ---- friendly / raw address codec ------------------------------------------
def format_address(workchain: int, hash32: bytes, bounceable: bool = True, test_only: bool = False) -> str:
    tag = TAG_BOUNCEABLE if bounceable else TAG_NONBOUNCEABLE
    if test_only:
        tag |= TAG_TEST
    wc = 0xFF if workchain == -1 else (workchain & 0xFF)
    addr = bytes([tag, wc]) + bytes(hash32)
    crc = crc16_ccitt(addr)
    return to_base64(addr + crc, url_safe=True)


def raw_address(workchain: int, hash32: bytes) -> str:
    return f"{workchain}:{bytes(hash32).hex()}"


def parse_address(s: str) -> dict:
    import re
    t = str(s).strip()
    m = re.match(r"^(-?\d+):([0-9a-fA-F]{64})$", t)
    if m:
        return {"workchain": int(m.group(1)), "hash": bytes.fromhex(m.group(2)),
                "bounceable": True, "test_only": False}
    data = from_base64(t)
    if len(data) != 36:
        raise ValueError("ton: bad address length")
    crc = crc16_ccitt(data[:34])
    if crc[0] != data[34] or crc[1] != data[35]:
        raise ValueError("ton: bad address crc")
    tag = data[0]
    test_only = bool(tag & TAG_TEST)
    tag &= ~TAG_TEST
    if tag not in (TAG_BOUNCEABLE, TAG_NONBOUNCEABLE):
        raise ValueError("ton: bad address tag")
    wc = -1 if data[1] == 0xFF else data[1]
    return {"workchain": wc, "hash": data[2:34],
            "bounceable": tag == TAG_BOUNCEABLE, "test_only": test_only}


def is_ton_address(s: str) -> bool:
    try:
        parse_address(s)
        return True
    except Exception:
        return False


def load_msg_address(cell: Cell):
    o = [0]

    def rd(n):
        v = 0
        for _ in range(n):
            v = (v << 1) | ((cell.bits_packed[o[0] >> 3] >> (7 - (o[0] & 7))) & 1)
            o[0] += 1
        return v

    tag = rd(2)
    if tag == 0:
        return None
    if tag != 2:
        raise ValueError(f"ton: unsupported addr tag {tag}")
    if rd(1):
        raise ValueError("ton: anycast addr unsupported")
    wc = rd(8)
    if wc > 127:
        wc -= 256
    h = bytes(rd(8) for _ in range(32))
    return {"workchain": wc, "hash": h}


def address_cell(addr: dict) -> Cell:
    return begin_cell().store_address(addr).end_cell()
