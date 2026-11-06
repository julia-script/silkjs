#!/usr/bin/env python3
"""Generate src/intl_collation_data.silk from the CLDR root collation and tailorings.

Inputs (CLDR release-48 git tree, common/ directory):
  uca/FractionalUCA.txt   root collation elements as ICU uses them
  collation/*.xml         per-locale tailoring rules

The generator parses the root table, builds every tailoring the way ICU's
CollationBuilder does (reset positions, strengths, [before n], expansions,
imports, reordering, options), and emits:

  * the root table: code point runs, single and expanded CEs, contractions,
    prefix mappings and the Han radical-stroke order,
  * one record per (locale, collation type): option flags, a reorder table and
    the tailored mappings with their final weights.

Weights are not ICU's bytes. Every distinct root primary, secondary and
tertiary is replaced by its rank, scaled so that tailored weights fit in the
gaps: primary = rank << 16, secondary = rank << 6, tertiary = rank << 8 with
the case bits in bits 14 and 15 like ICU. Comparison only needs the order.

Usage: generate_intl_collation.py CLDR_COMMON_DIR OUTPUT.silk
"""
import bisect
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
from functools import lru_cache

P_SHIFT = 16
S_SHIFT = 16
T_SHIFT = 8
HAN_BASE = 0xE0000000
UNASSIGNED_BASE = 0xFE000000
FFFD_PRIMARY = 0xFFFD0000
FFFF_PRIMARY = 0xFFFF0000
CASE_MASK = 0xC000
UPPER = 0x8000

HAN_BLOCKS = [(0x4E00, 0x9FFF), (0xFA0E, 0xFA29), (0x3400, 0x4DBF), (0x20000, 0x2A6DF),
              (0x2A700, 0x2B81D), (0x2B820, 0x2CEAD), (0x2CEB0, 0x2EBE0), (0x2EBF0, 0x2EE5D),
              (0x30000, 0x3134A), (0x31350, 0x33479)]
SPECIAL_GROUPS = ['space', 'punct', 'symbol', 'currency', 'digit']


def nfd(text):
    return unicodedata.normalize('NFD', text)


def han_block(c):
    for i, (a, b) in enumerate(HAN_BLOCKS):
        if a <= c <= b:
            return 0 if i < 2 else i - 1
    return -1


class Root:
    """The CLDR root collation from FractionalUCA.txt, with weights as ranks."""

    def __init__(self, path):
        self.raw = {}        # tuple of code points -> list of (p32, s16, t16)
        self.prefix = {}     # (prefix cp, cp) -> CEs
        self.specials = {}   # '[first variable]' etc -> CE
        self.scripts = {}    # cp -> script code from the comments
        self.markers = []    # (p32, representative cp, starts lead byte)
        self.han_order = []
        han_refs = []
        for line in open(path, encoding='utf8'):
            if line.startswith('[radical') and ':' in line:
                body = line.rstrip().rstrip(']').split(':', 1)[1]
                i = 0
                while i < len(body):
                    if i + 2 < len(body) and body[i + 1] == '-':
                        self.han_order.extend(range(ord(body[i]), ord(body[i + 2]) + 1))
                        i += 3
                    else:
                        self.han_order.append(ord(body[i]))
                        i += 1
                continue
            m = re.match(r'\[((?:first|last) [a-z ]+?) (\[[^\]]*\])\]', line)
            if m:
                self.specials[m.group(1)] = self.parse_ces(m.group(2))[0]
                continue
            if not line or line[0] in '#[\n':
                continue
            key, rest = line.split(';', 1)
            body, _, comment = rest.partition('#')
            ces = self.parse_ces(body)
            if '|' in key:
                a, b = key.split('|')
                self.prefix[(int(a, 16), int(b, 16))] = ces
                continue
            cps = tuple(int(x, 16) for x in key.split())
            if cps == (0xFDD0, 0x0034):
                self.numeric_primary = ces[0][0]
                continue
            if cps[0] in (0xFDD0, 0xFDD1):
                if cps[0] == 0xFDD1 and len(cps) == 2:
                    self.markers.append((ces[0][0], cps[1], 'starts new lead byte' in comment))
                # Rules can reset on these; the runtime tables leave them out.
                self.raw[cps] = ces
                continue
            self.raw[cps] = ces
            fields = comment.split()
            if len(cps) == 1 and fields:
                self.scripts[cps[0]] = fields[0]
        self.han_key = {}
        segment = 0
        previous = None
        for c in self.han_order:
            key = (han_block(c), c)
            if previous is not None and key < previous:
                segment += 1
            self.han_key[c] = (segment, key[0], c)
            previous = key
        self.han_segments = segment + 1
        self.han_set = set(self.han_order)
        primaries = set()
        secondaries = set()
        tertiaries = set()
        for ces in list(self.raw.values()) + list(self.prefix.values()) + [[v] for v in self.specials.values()]:
            for ce in ces:
                if ce[0] == 'han':
                    secondaries.add(ce[2])
                    tertiaries.add(ce[3] & 0x3F3F)
                    continue
                if ce[0]:
                    primaries.add(ce[0])
                if ce[1]:
                    secondaries.add(ce[1])
                if ce[2]:
                    tertiaries.add(ce[2] & 0x3F3F)
        for marker in self.markers:
            primaries.add(marker[0])
        primaries.add(self.numeric_primary)
        self.p_rank = {p: i + 1 for i, p in enumerate(sorted(primaries))}
        self.s_rank = {s: i + 1 for i, s in enumerate(sorted(secondaries))}
        self.t_rank = {t: i + 1 for i, t in enumerate(sorted(tertiaries))}
        assert len(self.p_rank) < (HAN_BASE >> P_SHIFT)
        assert (len(self.t_rank) + 1) << T_SHIFT < 0x4000
        self.common_s = self.s_rank[0x0500] << S_SHIFT
        self.common_t = self.t_rank[0x0500] << T_SHIFT
        self.ces = {k: [c for ce in v for c in self.scale(ce)] for k, v in self.raw.items()}
        self.prefix_ces = {k: [c for ce in v for c in self.scale(ce)] for k, v in self.prefix.items()}
        self.contractions = {}
        for k in self.ces:
            if len(k) > 1:
                for n in range(1, len(k)):
                    self.contractions.setdefault(k[:n], False)
                self.contractions[k] = True
        self.max_variable = self.scale_primary(0x0BFFFFFF)
        self.variable_top = max(p for p in self.p_rank if p <= 0x0BFFFFFF)
        self.variable_top = self.p_rank[self.variable_top] << P_SHIFT
        self.groups = self.make_groups()
        self.numeric_base = self.p_rank[self.numeric_primary] << P_SHIFT

    @staticmethod
    def parse_ces(text):
        out = []
        for m in re.finditer(r'\[([^\]]*)\]', text):
            g = m.group(1)
            f = [x.strip() for x in g.split(',')]
            if f[0].startswith('U+'):
                cp = int(f[0][2:], 16)
                if len(f) == 1:
                    s, t = 0x0500, 0x0500
                elif len(f) == 2:
                    s, t = 0x0500, Root.weight16(f[1])
                else:
                    s, t = Root.weight16(f[1]), Root.weight16(f[2])
                out.append(('han', cp, s, t))
                continue
            p = bytes.fromhex(f[0].replace(' ', ''))
            out.append((int.from_bytes(p.ljust(4, b'\0'), 'big') if p else 0,
                        Root.weight16(f[1]), Root.weight16(f[2])))
        return out

    @staticmethod
    def weight16(text):
        b = bytes.fromhex(text.replace(' ', ''))
        if not b:
            return 0
        return (b[0] << 8) | (b[1] if len(b) > 1 else 0)

    def scale_primary(self, p):
        if p == 0:
            return 0
        if p in self.p_rank:
            return self.p_rank[p] << P_SHIFT
        best = max(q for q in self.p_rank if q <= p)
        return (self.p_rank[best] << P_SHIFT) | 0xFFFF

    def scale(self, ce):
        """Root CE -> list of runtime CEs (p, s, t16 with case bits)."""
        if ce[0] == 'han':
            first, second = self.han_ces(ce[1])
            s = self.s_rank[ce[2]] << S_SHIFT
            t = (self.t_rank[ce[3] & 0x3F3F] << T_SHIFT) | (ce[3] & CASE_MASK)
            return [(first[0], s, t), second]
        p, s, t = ce
        return [(self.p_rank[p] << P_SHIFT if p else 0,
                 self.s_rank[s] << S_SHIFT if s else 0,
                 ((self.t_rank[t & 0x3F3F] << T_SHIFT) | (t & CASE_MASK)) if t else 0)]

    def han_ces(self, c):
        segment, block, cp = self.han_key[c]
        offset = cp - HAN_BLOCKS[block + 1 if block > 0 else (0 if cp <= 0x9FFF else 1)][0]
        if block == 0 and cp >= 0xFA0E:
            offset += 0x5200
        return ((HAN_BASE + (segment << 8), self.common_s, self.common_t),
                (HAN_BASE + (block << 17) + offset + 1, 0, 0))

    def implicit(self, c):
        if c in self.han_set:
            return list(self.han_ces(c))
        if c == 0xFFFD:
            return [(FFFD_PRIMARY, self.common_s, self.common_t)]
        if c == 0xFFFF:
            return [(FFFF_PRIMARY, self.common_s, self.common_t)]
        return [(UNASSIGNED_BASE + c + 1, self.common_s, self.common_t)]

    def lookup(self, c):
        ces = self.ces.get((c,))
        if ces is None:
            return self.implicit(c)
        return ces

    def make_groups(self):
        """Reorder groups: (code list, first scaled primary, limit scaled primary)."""
        groups = []
        markers = sorted(self.markers)
        current = None
        for p, cp, starts in markers:
            if cp == 0xFDD0:
                continue
            name = 'Hani' if cp in self.han_set else self.scripts.get(cp, '')
            if not name:
                name = self.scripts.get(ord(nfd(chr(cp))[0]), '')
            if cp == 0x00A0:
                code = 'space'
            elif cp == 0x201C:
                code = 'punct'
            elif cp == 0x263A:
                code = 'symbol'
            elif cp == 0x20AC:
                code = 'currency'
            elif cp == 0x0034:
                code = 'digit'
            else:
                code = name
            special = code in SPECIAL_GROUPS
            if current is None or starts or special or (current[0][0] in SPECIAL_GROUPS):
                current = [[code], self.p_rank[p] << P_SHIFT, None]
                groups.append(current)
            else:
                current[0].append(code)
        for i, g in enumerate(groups):
            g[2] = groups[i + 1][1] if i + 1 < len(groups) else HAN_BASE
        for g in groups:
            if 'Hani' in g[0]:
                g[2] = UNASSIGNED_BASE
        aliases = {'Hira': 'Kana', 'Hrkt': 'Kana', 'Hans': 'Hani', 'Hant': 'Hani', 'Jpan': 'Hani', 'Kore': 'Hang'}
        for g in groups:
            for a, b in aliases.items():
                if b in g[0] and a not in g[0]:
                    g[0].append(a)
        return [(tuple(g[0]), g[1], g[2]) for g in groups]


class Tailoring:
    """One built tailoring: options, reorder table and mappings with final weights."""

    def __init__(self):
        self.case_first = 0      # 0 off, 1 lower, 2 upper
        self.backwards = False
        self.shifted = False
        self.strength = 3
        self.reorder = []        # (start, limit, delta) on scaled primaries
        self.reorder_codes = []
        self.mappings = {}       # tuple cps -> list of CEs
        self.suppressed = set()


class Builder:
    """ICU CollationBuilder emulation on a node list of root and tailored weights."""

    def __init__(self, root):
        self.root = root
        self.tailoring = Tailoring()
        self.next = {}
        self.prev = {}
        self.strength = {}     # tailored node id -> strength relative to its predecessor
        self.ce_strengths = {}  # tailored node id -> strength of its CE
        self.ces = []
        self.counter = 0
        self.mapping = {}      # tuple cps -> list of (node, case)
        nodes = set()
        for ces in list(root.ces.values()) + list(root.prefix_ces.values()):
            for ce in ces:
                nodes.add(self.root_node(ce))
        for v in root.specials.values():
            for ce in root.scale(v) if v[0] != 'han' else []:
                nodes.add(self.root_node(ce))
        for marker in root.markers:
            nodes.add((root.p_rank[marker[0]] << P_SHIFT, root.common_s, root.common_t))
        nodes.add((0, 0, 0))
        self.sorted_roots = sorted(nodes)
        self.head = self.sorted_roots[0]
        for a, b in zip(self.sorted_roots, self.sorted_roots[1:]):
            self.next[a] = b
            self.prev[b] = a
        self.next[self.sorted_roots[-1]] = None
        self.prev[self.head] = None

    @staticmethod
    def root_node(ce):
        return (ce[0], ce[1], ce[2] & ~CASE_MASK & 0xFFFF)

    def node_strength(self, node):
        if isinstance(node, int):
            return self.strength[node]
        i = bisect.bisect_left(self.sorted_roots, node)
        if i == 0:
            return 1
        return self.root_strength(self.sorted_roots[i - 1], node)

    @staticmethod
    def root_strength(a, b):
        if a[0] != b[0]:
            return 1
        if a[1] != b[1]:
            return 2
        if a[2] != b[2]:
            return 3
        return 15

    def ensure_root(self, node):
        if node in self.next or node in self.prev:
            return
        i = bisect.bisect_left(self.sorted_roots, node)
        before = self.sorted_roots[i - 1] if i > 0 else None
        self.sorted_roots.insert(i, node)
        # Place after the previous root node and all tailored nodes after it.
        after = before
        while after is not None and self.next.get(after) is not None and isinstance(self.next[after], int):
            after = self.next[after]
        nxt = self.next.get(after) if after is not None else self.head
        self.next[node] = nxt
        self.prev[node] = after
        if after is not None:
            self.next[after] = node
        else:
            self.head = node
        if nxt is not None:
            self.prev[nxt] = node

    def insert_after(self, position, strength):
        current = position
        while True:
            nxt = self.next.get(current)
            if nxt is None or self.node_strength(nxt) <= strength:
                break
            current = nxt
        node = self.counter
        self.counter += 1
        nxt = self.next.get(current)
        self.strength[node] = strength
        self.next[current] = node
        self.prev[node] = current
        self.next[node] = nxt
        if nxt is not None:
            self.prev[nxt] = node
        return node

    def insert_before(self, position, node_value):
        """Insert root-like synthetic node right before position."""
        bisect.insort(self.sorted_roots, node_value)
        before = self.prev[position]
        self.prev[position] = node_value
        self.next[node_value] = position
        self.prev[node_value] = before
        if before is None:
            self.head = node_value
        else:
            self.next[before] = node_value

    # CEs of a string during building, as (node, case) pairs.
    def string_ces(self, cps):
        out = []
        i = 0
        while i < len(cps):
            best = 0
            for n in range(len(cps) - i, 0, -1):
                if tuple(cps[i:i + n]) in self.mapping:
                    best = n
                    break
            root_len = 0
            for n in range(len(cps) - i, 1, -1):
                if tuple(cps[i:i + n]) in self.root.ces:
                    root_len = n
                    break
            if best and best >= root_len:
                out.extend(self.mapping[tuple(cps[i:i + best])])
                i += best
                continue
            key = tuple(cps[i:i + max(root_len, 1)])
            ces = self.root.ces.get(key) if len(key) > 1 or key in self.root.ces else None
            if ces is None:
                ces = self.root.implicit(cps[i])
                key = (cps[i],)
            for ce in ces:
                node = self.root_node(ce)
                self.ensure_root(node)
                out.append((node, ce[2] & CASE_MASK))
            i += len(key)
        return out

    def special_position(self, name):
        root = self.root
        if name in ('first tertiary ignorable', 'last tertiary ignorable'):
            return (0, 0, 0)
        if name == 'last regular':
            han = [g for g in root.groups if 'Hani' in g[0]][0]
            node = (han[1], root.common_s, root.common_t)
            self.ensure_root(node)
            return self.last_in_primary(node) if False else node
        if name == 'first implicit':
            first = root.han_ces(0x4E00)[0]
            node = (first[0], first[1], first[2])
            self.ensure_root(node)
            return node
        ce = root.specials[name]
        node = self.root_node(root.scale(ce)[0])
        self.ensure_root(node)
        if name.startswith('last'):
            return node
        return node

    def last_in_primary(self, node):
        return node

    def group_start(self, node, level):
        """Walk back to the first node of node's group at the given level."""
        current = node
        while self.node_strength(current) > level and self.prev.get(current) is not None:
            current = self.prev[current]
        return current

    def ce_strength(self, node):
        """Strength of a CE: the strongest level with a nonzero weight."""
        if isinstance(node, int):
            return self.ce_strengths[node]
        if node[0]:
            return 1
        if node[1]:
            return 2
        if node[2]:
            return 3
        return 15

    def reset(self, cps, before, special):
        """ICU CollationBuilder::addReset: set the current CEs."""
        if special is not None:
            ces = [(self.special_position(special), 0)]
        else:
            ces = self.string_ces(cps)
        if not ces:
            ces = [((0, 0, 0), 0)]
        if before:
            ces = self.pop_weaker(ces, before)
            last = ces[-1][0]
            start = self.group_start(last, before)
            if self.node_strength(start) < before or self.prev.get(start) is None:
                # The group also starts a stronger group: make a synthetic
                # weight just below it at the requested level.
                weights = self.weights_of_root(start)
                if before == 2:
                    node = (weights[0], weights[1] - (1 << (S_SHIFT - 1)), self.root.common_t)
                else:
                    node = (weights[0], weights[1], weights[2] - (1 << (T_SHIFT - 1)))
                if node not in self.prev:
                    self.insert_before(start, node)
            else:
                node = self.group_start(self.prev[start], before)
            ces[-1] = (node, 0)
        self.ces = ces

    def pop_weaker(self, ces, strength):
        ces = list(ces)
        while ces and self.ce_strength(ces[-1][0]) > strength:
            ces.pop()
        if not ces:
            ces = [((0, 0, 0), 0)]
        return ces

    def weights_of_root(self, node):
        while isinstance(node, int):
            node = self.prev[node]
        return node

    def add_relation(self, strength, cps, extension, context):
        """ICU CollationBuilder::addRelation."""
        if strength != 15:
            self.ces = self.pop_weaker(self.ces, strength)
            last = self.ces[-1][0]
            node = self.insert_after(last, strength)
            self.ce_strengths[node] = min(strength, self.ce_strength(last))
            self.ces[-1] = (node, 0)
        ces = list(self.ces)
        if extension:
            ces += self.string_ces(extension)
        key = tuple(cps)
        if context:
            key = ('ctx', tuple(context), key)
        self.mapping[key] = ces

    def finish(self):
        """Assign weights to tailored nodes and resolve mappings."""
        weights = {}
        node = self.head
        previous = None
        root = self.root
        while node is not None:
            if isinstance(node, tuple):
                weights[node] = node
            else:
                w = weights[previous]
                s = self.strength[node]
                # Like ICU, weights tailored after an ignorable level start above common.
                if s == 1:
                    weights[node] = (w[0] + 1, root.common_s, root.common_t)
                elif s == 2:
                    weights[node] = (w[0], (w[1] or root.common_s) + 1, root.common_t)
                elif s == 3:
                    weights[node] = (w[0], w[1], (w[2] or root.common_t) + 1)
                else:
                    weights[node] = w
            previous = node
            node = self.next.get(node)
        # Every tailored weight must stay below the next root weight.
        node = self.head
        last_root = None
        pending = []
        while node is not None:
            if isinstance(node, tuple):
                for p in pending:
                    assert weights[p] < node, (weights[p], node)
                pending = []
            else:
                pending.append(node)
            node = self.next.get(node)
        out = {}
        for key, ces in self.mapping.items():
            resolved = []
            for n, case in ces:
                w = weights[n]
                resolved.append([w[0], w[1], w[2] | case if w[2] else 0])
            cps = key[2] if key[0] == 'ctx' else key
            self.set_case_bits(cps, resolved)
            out[key] = [tuple(c) for c in resolved]
        self.tailoring.mappings = out
        return self.tailoring

    def set_case_bits(self, cps, ces):
        """ICU CollationBuilder::setCaseBits."""
        tailored_primaries = sum(1 for c in ces if c[0] != 0)
        cases = 0
        if tailored_primaries > 0:
            base = []
            for c in cps:
                base.extend(self.root.lookup(c))
            last_case = 0
            base_primaries = 0
            for ce in base:
                if ce[0] != 0:
                    base_primaries += 1
                    c = (ce[2] >> 14) & 3
                    if base_primaries < tailored_primaries:
                        cases |= c << ((base_primaries - 1) * 2)
                    elif base_primaries == tailored_primaries:
                        last_case = c
                    elif c != last_case:
                        last_case = 1
                        break
            if base_primaries >= tailored_primaries:
                cases |= last_case << ((tailored_primaries - 1) * 2)
        for ce in ces:
            ce[2] &= ~CASE_MASK & 0xFFFF
            if ce[0] != 0:
                ce[2] |= (cases & 3) << 14
                cases >>= 2
            elif ce[1] == 0 and ce[2] != 0:
                ce[2] |= UPPER


class RuleParser:
    """LDML collation rule syntax."""

    def __init__(self, text):
        self.s = text
        self.i = 0

    def skip(self):
        s = self.s
        while self.i < len(s):
            c = s[self.i]
            if c in ' \t\r\n‎‏':
                self.i += 1
            elif c == '#':
                while self.i < len(s) and s[self.i] != '\n':
                    self.i += 1
            else:
                break

    def peek(self):
        self.skip()
        return self.s[self.i] if self.i < len(self.s) else ''

    def string(self):
        """Read a run of literal characters (until syntax or whitespace)."""
        out = []
        s = self.s
        self.skip()
        while self.i < len(s):
            c = s[self.i]
            if c == "'":
                self.i += 1
                if self.i < len(s) and s[self.i] == "'":
                    out.append("'")
                    self.i += 1
                    continue
                while self.i < len(s):
                    if s[self.i] == "'":
                        if self.i + 1 < len(s) and s[self.i + 1] == "'":
                            out.append("'")
                            self.i += 2
                            continue
                        self.i += 1
                        break
                    if s[self.i] == '\\':
                        out.append(self.escape())
                        continue
                    out.append(s[self.i])
                    self.i += 1
                continue
            if c == '\\':
                out.append(self.escape())
                continue
            if c in ' \t\r\n&<=/|#[]' or c == '‎' or c == '‏':
                break
            out.append(c)
            self.i += 1
        return ''.join(out)

    def escape(self):
        s = self.s
        n = s[self.i + 1]
        if n == 'u':
            self.i += 6
            return chr(int(s[self.i - 4:self.i], 16))
        if n == 'U':
            self.i += 10
            return chr(int(s[self.i - 8:self.i], 16))
        if n == 'x':
            if s[self.i + 2] == '{':
                end = s.index('}', self.i)
                value = int(s[self.i + 3:end], 16)
                self.i = end + 1
                return chr(value)
            self.i += 4
            return chr(int(s[self.i - 2:self.i], 16))
        self.i += 2
        return n

    def bracket(self):
        s = self.s
        depth = 0
        start = self.i
        while self.i < len(s):
            c = s[self.i]
            if c == '\\':
                self.i += 2
                continue
            if c == '[':
                depth += 1
            elif c == ']':
                depth -= 1
                if depth == 0:
                    self.i += 1
                    return s[start + 1:self.i - 1]
            self.i += 1
        raise ValueError('unterminated bracket')


def expand_star(text):
    """Characters of a starred relation, with a-b ranges."""
    out = []
    i = 0
    chars = list(text)
    while i < len(chars):
        if i + 2 < len(chars) and chars[i + 1] == '-':
            out.extend(chr(c) for c in range(ord(chars[i]), ord(chars[i + 2]) + 1))
            i += 3
        else:
            out.append(chars[i])
            i += 1
    return out


class Cldr:
    def __init__(self, common):
        self.common = common
        self.root = Root(common + '/uca/FractionalUCA.txt')
        self.rules = {}
        import os
        for name in sorted(os.listdir(common + '/collation')):
            if not name.endswith('.xml'):
                continue
            tree = ET.parse(common + '/collation/' + name)
            locale = name[:-4]
            entry = {'default': 'standard', 'types': {}}
            for col in tree.iter('collations'):
                d = col.find('defaultCollation')
                if d is not None:
                    entry['default'] = d.text.strip()
                # ICU builds its data from the alt='short' Chinese tailorings, which list
                # only common characters; the rest fall back to the implicit Han order.
                shorts = {c.get('type') for c in col.findall('collation') if c.get('alt') == 'short'}
                for c in col.findall('collation'):
                    if c.get('alt') != ('short' if c.get('type') in shorts else None):
                        continue
                    cr = c.find('cr')
                    entry['types'][c.get('type')] = cr.text if cr is not None and cr.text else ''
            self.rules[locale] = entry
        # CLDR's parentLocales for the collations component: Bokmål and Nynorsk files are
        # empty and take the Norwegian tailoring.
        for child, parent in COLLATION_PARENTS.items():
            if not self.rules[child]['types']:
                self.rules[child] = {'default': self.rules[parent]['default'], 'types': dict(self.rules[parent]['types'])}

    def rule_text(self, locale, ctype):
        entry = self.rules.get(locale)
        if entry is None:
            return None
        return entry['types'].get(ctype)

    def build(self, locale, ctype):
        builder = Builder(self.root)
        text = self.rule_text(locale, ctype)
        if text is None:
            text = self.rule_text(locale, self.rules[locale]['default']) or ''
        self.apply(builder, text, set())
        tailoring = builder.finish()
        tailoring.reorder = reorder_table(self.root, tailoring.reorder_codes)
        return tailoring

    def apply(self, builder, text, seen):
        p = RuleParser(text)
        t = builder.tailoring
        position = None
        prefix = []
        root = self.root
        while True:
            c = p.peek()
            if not c:
                break
            if c == '[':
                option = p.bracket().strip()
                words = option.split()
                if words[0] == 'import':
                    name = words[1]
                    m = re.match(r'([a-zA-Z_-]+?)(?:-u-co-([a-z0-9-]+))?$', name)
                    loc = m.group(1).replace('-', '_')
                    ctype = m.group(2) or None
                    if loc == 'und':
                        loc = 'root'
                    if ctype is None:
                        ctype = self.rules[loc]['default']
                    ctype = {'trad': 'traditional', 'phonebk': 'phonebook', 'dict': 'dictionary'}.get(ctype, ctype)
                    self.apply(builder, self.rule_text(loc, ctype) or '', seen)
                elif words[0] == 'reorder':
                    t.reorder_codes = words[1:]
                elif words[0] == 'caseFirst':
                    t.case_first = {'off': 0, 'lower': 1, 'upper': 2}[words[1]]
                elif words[0] == 'backwards':
                    t.backwards = True
                elif words[0] == 'alternate':
                    t.shifted = words[1] == 'shifted'
                elif words[0] == 'strength':
                    t.strength = {'1': 1, '2': 2, '3': 3, '4': 4, 'I': 15}[words[1]]
                elif words[0] in ('normalization', 'optimize', 'maxVariable', 'hiraganaQ', 'numericOrdering', 'caseLevel'):
                    pass
                elif words[0] == 'suppressContractions':
                    body = option[len('suppressContractions'):].strip()[1:-1]
                    t.suppressed |= {ord(x) for x in expand_star(body.replace('\\u19B5', 'ᦵ').replace('\\u19B7', 'ᦷ').replace('\\u19BA', 'ᦺ').replace(' ', ''))}
                else:
                    raise ValueError('option ' + option)
                continue
            if c == '&':
                p.i += 1
                before = 0
                special = None
                if p.peek() == '[':
                    option = p.bracket().strip()
                    if option.startswith('before'):
                        before = int(option.split()[1])
                        if p.peek() == '[':
                            special = p.bracket().strip()
                    else:
                        special = option
                cps = [] if special else [ord(x) for x in nfd(p.string())]
                builder.reset(cps, before, special)
                continue
            m = re.match(r'(<<<<|<<<|<<|<|=)(\*?)', p.s[p.i:])
            if not m:
                raise ValueError('syntax at ' + repr(p.s[p.i:p.i + 40]))
            p.i += m.end()
            strength = {'<': 1, '<<': 2, '<<<': 3, '<<<<': 15, '=': 15}[m.group(1)]
            if m.group(2):
                items = expand_star(p.string())
            else:
                items = [p.string()]
            for item in items:
                context = None
                extension = None
                if not m.group(2):
                    if p.peek() == '|':
                        p.i += 1
                        context = item
                        item = p.string()
                    if p.peek() == '/':
                        p.i += 1
                        extension = p.string()
                cps = [ord(x) for x in nfd(item)]
                ctx = [ord(x) for x in nfd(context)] if context else None
                ext = [ord(x) for x in nfd(extension)] if extension else None
                builder.add_relation(strength, cps, ext, ctx)
        return t


def reorder_table(root, codes):
    """ICU CollationData::makeReorderRanges on scaled primaries."""
    if not codes:
        return []
    groups = root.groups
    index = {}
    for i, g in enumerate(groups):
        for code in g[0]:
            index.setdefault(code, i)
    order = []
    names = []
    for code in codes:
        code = {'others': 'Zzzz', 'space': 'space', 'punct': 'punct', 'symbol': 'symbol',
                'currency': 'currency', 'digit': 'digit'}.get(code, code)
        names.append(code)
    specials = [n for n in names if n in SPECIAL_GROUPS]
    for i, g in enumerate(groups):
        if g[0][0] in SPECIAL_GROUPS and g[0][0] not in specials:
            order.append(i)
    high = []
    k = 0
    while k < len(names):
        n = names[k]
        k += 1
        if n == 'Zzzz':
            high = [index[x] for x in names[k:] if x in index]
            break
        if n in index and index[n] not in order:
            order.append(index[n])
    for i in range(len(groups)):
        if i not in order and i not in high:
            order.append(i)
    order += high
    table = []
    start = groups[0][1]
    for i in order:
        g = groups[i]
        table.append((g[1], g[2], start - g[1]))
        start += g[2] - g[1]
    # Neighboring groups that move by the same amount make one range.
    merged = []
    for low, high, delta in sorted(x for x in table if x[2] != 0):
        if merged and merged[-1][1] == low and merged[-1][2] == delta:
            merged[-1] = (merged[-1][0], high, delta)
        else:
            merged.append((low, high, delta))
    return merged


class Collator:
    """Reference comparison with the same semantics as the Silk runtime."""

    def __init__(self, root, tailoring, strength=3, case_level=False, case_first=None,
                 numeric=False, shifted=None):
        self.root = root
        self.t = tailoring
        self.strength = strength
        self.case_level = case_level
        self.case_first = tailoring.case_first if case_first is None else case_first
        self.numeric = numeric
        self.shifted = tailoring.shifted if shifted is None else shifted
        self.keys = {}
        self.max_len = 1
        self.starts = set()
        for k in tailoring.mappings:
            if k[0] == 'ctx':
                continue
            self.max_len = max(self.max_len, len(k))
            for n in range(1, len(k) + 1):
                self.keys.setdefault(k[:n], False)
            self.keys[k] = True

    def mapping(self, key):
        return self.t.mappings.get(key)

    def ces(self, text):
        root = self.root
        cps = [ord(c) for c in nfd(text)]
        out = []
        i = 0
        while i < len(cps):
            c = cps[i]
            if self.numeric and unicodedata.decimal(chr(c), None) is not None:
                j = i
                digits = []
                while j < len(cps) and unicodedata.decimal(chr(cps[j]), None) is not None:
                    digits.append(unicodedata.decimal(chr(cps[j])))
                    j += 1
                while len(digits) > 1 and digits[0] == 0:
                    digits.pop(0)
                out.extend(self.numeric_ces(digits))
                i = j
                continue
            if i > 0 and (cps[i - 1], c) in root.prefix_ces and (c,) not in self.t.mappings:
                out.extend(root.prefix_ces[(cps[i - 1], c)])
                i += 1
                continue
            # Longest contiguous match.
            length = 1
            ces = self.find((c,))
            k = i + 2
            while k <= len(cps) and self.is_prefix(tuple(cps[i:k])):
                found = self.find(tuple(cps[i:k]))
                if found is not None:
                    ces = found
                    length = k - i
                k += 1
            key = list(cps[i:i + length])
            # Discontiguous extension over unblocked non-starters.
            j = i + length
            last_ccc = 0
            skipped = False
            while j < len(cps):
                ccc = unicodedata.combining(chr(cps[j]))
                if ccc == 0:
                    break
                if (not skipped or last_ccc < ccc) and self.is_prefix(tuple(key + [cps[j]])):
                    found = self.find(tuple(key + [cps[j]]))
                    if found is not None:
                        key.append(cps[j])
                        ces = found
                        del cps[j]
                        continue
                skipped = True
                last_ccc = ccc
                j += 1
            out.extend(ces)
            i += length
        return out

    def reorder(self, p):
        for start, limit, delta in self.t.reorder:
            if start <= p < limit:
                return p + delta
        return p

    def numeric_ces(self, digits):
        root = self.root
        base = root.numeric_base
        out = [(base + min(len(digits), 0xFE), root.common_s, root.common_t)]
        for d in digits:
            out.append((base + 0x100 + d, root.common_s, root.common_t))
        return out

    def find(self, key):
        if key in self.t.mappings:
            return self.t.mappings[key]
        if len(key) > 1 and key[0] in self.t.suppressed:
            return None
        if key in self.root.ces:
            return self.root.ces[key]
        if len(key) == 1:
            return self.root.implicit(key[0])
        return None

    def is_prefix(self, key):
        if key in self.keys:
            return True
        return key in self.root.contractions and key[0] not in self.t.suppressed

    def compare(self, a, b):
        if a == b:
            return 0
        x = self.prepare(self.ces(a))
        y = self.prepare(self.ces(b))
        if self.t.reorder:
            x = [(self.reorder(ce[0]),) + tuple(ce[1:]) for ce in x]
            y = [(self.reorder(ce[0]),) + tuple(ce[1:]) for ce in y]
        r = self.cmp_primary(x, y)
        if r or self.strength == 1 and not self.case_level:
            return r
        if self.strength >= 2:
            sa = [c[1] for c in x if c[1]]
            sb = [c[1] for c in y if c[1]]
            if self.t.backwards:
                sa.reverse()
                sb.reverse()
            r = (sa > sb) - (sa < sb)
            if r:
                return r
        if self.case_level:
            r = self.cmp_case(x, y)
            if r or self.strength == 1:
                return r
        if self.strength >= 3:
            return self.cmp_tertiary(x, y)
        return 0

    def prepare(self, ces):
        if not self.shifted:
            return ces
        out = []
        variable = False
        for ce in ces:
            if ce[0] != 0 and ce[0] < self.root.variable_top + (1 << P_SHIFT):
                variable = True
                continue
            if ce[0] == 0 and variable:
                continue
            variable = False if ce[0] != 0 else variable
            out.append(ce)
        return out

    @staticmethod
    def cmp_primary(x, y):
        pa = [c[0] for c in x if c[0]]
        pb = [c[0] for c in y if c[0]]
        return (pa > pb) - (pa < pb)

    def cmp_case(self, x, y):
        if self.strength == 1:
            ca = [c[2] & CASE_MASK for c in x if c[0] != 0 and (c[1] or c[2])]
            cb = [c[2] & CASE_MASK for c in y if c[0] != 0 and (c[1] or c[2])]
        else:
            ca = [c[2] & CASE_MASK for c in x if c[1] != 0]
            cb = [c[2] & CASE_MASK for c in y if c[1] != 0]
        if self.case_first == 2:
            ca = [0xC000 - v for v in ca]
            cb = [0xC000 - v for v in cb]
        return (ca > cb) - (ca < cb)

    def cmp_tertiary(self, x, y):
        with_case = not self.case_level and self.case_first != 0
        def keys(ces):
            out = []
            for c in ces:
                t = c[2] if with_case else c[2] & ~CASE_MASK
                if t == 0:
                    continue
                if with_case and self.case_first == 2:
                    if c[1] != 0 or c[0] != 0:
                        t ^= CASE_MASK
                    else:
                        t += 0x4000
                out.append(t)
            return out
        a = keys(x)
        b = keys(y)
        return (a > b) - (a < b)


# ---------------------------------------------------------------------------
# Emission

# ICU ships no collation data for these CLDR locales; Node sorts them as root.
SKIPPED_LOCALES = {'aa', 'bal', 'bal_Latn', 'cu', 'dz', 'sgs', 'ssy', 'vo', 'wae'}
# Types V8 does not expose, or that ICU drops (de eor is draft; root eor wins).
SKIPPED_TYPES = {('cs', 'digits-after'), ('de', 'eor')}
TYPE_IDS = ['standard', 'search', 'traditional', 'phonebook', 'dictionary', 'phonetic', 'compat',
            'eor', 'emoji', 'pinyin', 'stroke', 'zhuyin', 'unihan', 'searchjl']
CHAIN_MIN = 8


def le(value, size):
    return int(value).to_bytes(size, 'little', signed=value < 0)


def varint(value):
    out = bytearray()
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


class Emitter:
    def __init__(self, cldr, types=None):
        self.cldr = cldr
        self.root = cldr.root
        self.types = types
        self.st = {}
        self.st_list = []

    def st_index(self, s, t):
        key = (s, t)
        if key not in self.st:
            self.st[key] = len(self.st_list)
            self.st_list.append(key)
        return self.st[key]

    def words(self, raw_ces):
        """Root CEs as u32 words: rank << 16 | st index; Han refs take two words."""
        out = []
        root = self.root
        for ce in raw_ces:
            if ce[0] == 'han':
                s = root.s_rank[ce[2]] << S_SHIFT
                t = (root.t_rank[ce[3] & 0x3F3F] << T_SHIFT) | (ce[3] & CASE_MASK)
                out.append((0xFFFF << 16) | self.st_index(s, t))
                out.append(ce[1])
                continue
            scaled = root.scale(ce)[0]
            out.append(((scaled[0] >> P_SHIFT) << 16) | self.st_index(scaled[1], scaled[2]))
        return out

    def root_tables(self):
        root = self.root
        singles = {}
        for k, v in root.raw.items():
            if k[0] in (0xFDD0, 0xFDD1):
                continue
            if len(k) == 1:
                c = k[0]
                if unicodedata.normalize('NFD', chr(c)) != chr(c):
                    continue
                singles[c] = self.words(v)
        def normal(cps):
            text = ''.join(map(chr, cps))
            return unicodedata.normalize('NFD', text) == text
        contractions = sorted(k for k in root.raw if len(k) > 1 and k[0] not in (0xFDD0, 0xFDD1) and normal(k))
        starters = {k[0] for k in contractions}
        prefixes = sorted(k for k in root.prefix if normal(k))
        prefixed = {k[1] for k in prefixes}
        pool = []
        items = []
        for c in sorted(singles):
            w = singles[c]
            flags = (2 if c in starters else 0) | (4 if c in prefixed else 0)
            if len(w) == 1 and (w[0] >> 16) != 0xFFFF:
                last = items[-1] if items else None
                if (last and not last[3] and flags == 0 and last[2] == 0 and last[0] + last[1] == c
                        and last[1] < 256 and (last[4] & 0xFFFF) == (w[0] & 0xFFFF)
                        and (last[4] >> 16) != 0 and (last[4] >> 16) + last[1] == (w[0] >> 16)):
                    last[1] += 1
                    continue
                items.append([c, 1, flags, False, w[0]])
            else:
                items.append([c, 1, flags, True, (len(pool) << 8) | len(w)])
                pool.extend(w)
        # Contraction starters that have no single mapping of their own still need an item.
        for c in sorted(starters | prefixed):
            if c not in singles:
                raise ValueError('starter without mapping %04X' % c)
        item_bytes = bytearray()
        for start, length, flags, expansion, value in items:
            head = (start << 11) | ((flags | (1 if expansion else 0)) << 8) | (length - 1)
            item_bytes += le(head, 4) + le(value, 4)
        pool_bytes = b''.join(le(w, 4) for w in pool)
        cblob = bytearray()
        cindex = bytearray()
        for k in contractions:
            cindex += le(len(cblob), 4)
            w = self.words(root.raw[k])
            cblob += bytes([len(k)]) + b''.join(le(c, 3) for c in k) + bytes([len(w)]) + b''.join(le(x, 4) for x in w)
        prefix = bytearray()
        for a, b in prefixes:
            w = self.words(root.prefix[(a, b)])
            assert len(w) == 1
            prefix += le(a, 3) + le(b, 3) + le(w[0], 4)
        ascii_ok = all(c in singles and len(singles[c]) == 1 and c not in starters for c in range(128))
        assert ascii_ok
        ascii = b''.join(le(singles[c][0], 4) for c in range(128))
        return {'items': bytes(item_bytes), 'pool': pool_bytes, 'cindex': bytes(cindex),
                'contractions': bytes(cblob), 'prefix': bytes(prefix), 'ascii': ascii,
                'item_count': len(items), 'contraction_count': len(contractions)}

    def han_tables(self):
        """Radical-stroke segments of the Han code points, as runs per block."""
        root = self.root
        runs = []
        for block_index, (a, b) in enumerate(HAN_BLOCKS):
            c = a
            while c <= b:
                if c not in root.han_key:
                    c += 1
                    continue
                seg = root.han_key[c][0]
                start = c
                while c + 1 <= b and (c + 1) in root.han_key and root.han_key[c + 1][0] == seg:
                    c += 1
                runs.append((start, c - start + 1, seg))
                c += 1
        runs.sort()
        stream = bytearray()
        index = bytearray()
        previous_end = 0
        previous_seg = 0
        for i, (start, length, seg) in enumerate(runs):
            if i % 64 == 0:
                index += le(start, 4) + le(len(stream), 4) + le(seg, 4)
                previous_end = start
                previous_seg = seg
            delta = seg - previous_seg
            stream += varint(start - previous_end) + varint(length - 1) + varint((delta << 1) ^ (delta >> 63) if delta < 0 else delta << 1)
            previous_end = start + length
            previous_seg = seg
        return {'han_index': bytes(index), 'han_runs': bytes(stream), 'han_run_count': len(runs)}


def ce_level_step(a, b):
    """The level at which CE b is CE a plus one, or 0."""
    if b[0] == a[0] + 1 and b[1] == a[1] and b[2] == a[2] and a[0] != 0:
        return 1
    if b[0] == a[0] and b[1] == a[1] + 1 and b[2] == a[2]:
        return 2
    if b[0] == a[0] and b[1] == a[1] and b[2] == a[2] + 1:
        return 3
    return 0


COMMON_S = None
COMMON_T = None


def ce_bytes(ce):
    """A tailored CE: u8 flags (bit 0 secondary follows, bit 1 tertiary follows), u32 primary,
    then the u32 secondary and u16 tertiary unless they are the common weights."""
    flags = (0 if ce[1] == COMMON_S else 1) | (0 if ce[2] == COMMON_T else 2)
    out = bytes([flags]) + le(ce[0], 4)
    if flags & 1:
        out += le(ce[1], 4)
    if flags & 2:
        out += le(ce[2], 2)
    return out


LATIN_LIMIT = 0x180
LATIN_BAIL = 0xFFFFFFFF


COLLATION_PARENTS = {'nb': 'no', 'nn': 'no'}
# Splits a context entry's code points from the reversed context before them.
CONTEXT_SEPARATOR = 0x110000
LATIN_JOINER_SET = set()
# Code points after the first of any contraction of the root or a tailoring.
CONTINUATION_SET = set()


def latin_ces(collator):
    """Per code point below LATIN_LIMIT: its CEs (raw, before reordering and shifting) when
    it has at most two and no contraction, prefix or context can join it with a neighbor
    below LATIN_LIMIT, else None. The fast paths need only these."""
    t = collator.t
    keys = [k for k in t.mappings if k[0] != 'ctx' and len(k) > 1]
    keys += [k for k in collator.root.ces if len(k) > 1 and k[0] not in t.suppressed
             and k[0] not in (0xFDD0, 0xFDD1) and k not in t.mappings]
    # The second code point of a root prefix mapping (l|middle dot) depends on the first.
    CONTINUATION_SET.update(c for k in list(t.mappings) + list(collator.root.ces) if k[0] != 'ctx' for c in k[1:])
    CONTINUATION_SET.update(c for k in t.mappings if k[0] == 'ctx' for c in k[2][1:])
    joined = {c for _, c in collator.root.prefix_ces}
    out = []
    for c in range(LATIN_LIMIT):
        n = tuple(ord(x) for x in nfd(chr(c)))
        if c in joined or any(len(k) > len(n) and k[:len(n)] == n and k[len(n)] < LATIN_LIMIT for k in keys):
            out.append(None)
            continue
        # A code point from LATIN_LIMIT up that continues a contraction of a covered one is a
        # combining mark or in LATIN_JOINERS; the wide-string fast path stops at either.
        LATIN_JOINER_SET.update(k[len(n)] for k in keys if len(k) > len(n) and k[:len(n)] == n
                                and not unicodedata.combining(chr(k[len(n)])))
        ces = [tuple(ce) for ce in collator.ces(chr(c))]
        out.append(tuple(ces) if len(ces) <= 2 else None)
    return out


def latin_bytes(entry):
    """Two CEs as u32 primary, u32 secondary, u16 tertiary; a missing CE is all zero and a
    code point the fast paths leave alone has LATIN_BAIL as its first primary."""
    if entry is None:
        entry = ((LATIN_BAIL, 0, 0),)
    ces = list(entry) + [(0, 0, 0)] * (2 - len(entry))
    return b''.join(le(p, 4) + le(s, 4) + le(t, 2) for p, s, t in ces)


def encode_record(tailoring, root_latin, root):
    """One tailoring record; see the data file's comment on `records()` for the layout."""
    singles = []
    for key, ces in tailoring.mappings.items():
        if key[0] != 'ctx' and len(key) == 1:
            singles.append((tuple(ces), key[0]))
    singles.sort()
    starters = {k[0] for k in tailoring.mappings if k[0] != 'ctx' and len(k) > 1}
    chains = []
    i = 0
    while i < len(singles):
        j = i + 1
        level = 0
        while j < len(singles):
            a, b = singles[j - 1][0], singles[j][0]
            if len(a) != len(b) or a[:-1] != b[:-1]:
                break
            step = ce_level_step(a[-1], b[-1])
            if step == 0 or (level and step != level):
                break
            level = step
            j += 1
        members = [c for _, c in singles[i:j]]
        if j - i >= CHAIN_MIN and not any(c in starters or c >= 0x40000 for c in members):
            chains.append((singles[i][0], level, members))
        i = j
    chained = {c for _, _, members in chains for c in members}
    entries = []
    contexts = []
    for key, ces in tailoring.mappings.items():
        if key[0] == 'ctx':
            contexts.append((tuple(key[2]) + (CONTEXT_SEPARATOR,) + tuple(reversed(key[1])), ces))
        elif not (len(key) == 1 and key[0] in chained):
            entries.append((tuple(key), ces))
    entries.sort()
    contexts.sort()

    def entry_blob(items):
        offsets = []
        blob = bytearray()
        for cps, ces in items:
            offsets.append(len(blob))
            blob += bytes([len(cps)]) + b''.join(le(c, 3) for c in cps) + bytes([len(ces)])
            blob += b''.join(ce_bytes(ce) for ce in ces)
        return offsets, blob

    entry_offsets, entry_bytes = entry_blob(entries)
    context_offsets, context_bytes = entry_blob(contexts)
    chain_offsets = []
    chain_bytes = bytearray()
    k = 0
    cells = {}
    for ces, level, members in chains:
        chain_offsets.append(len(chain_bytes))
        chain_bytes += le(k, 4) + bytes([level, len(ces)]) + b''.join(ce_bytes(ce) for ce in ces)
        for n, c in enumerate(members):
            cells[c] = k + n
        k += len(members)
    width = 2 if k <= 0xFFFF else 3
    page_table = bytearray()
    pages = bytearray()
    values = bytearray()
    if chains:
        rank = 0
        count = 0
        for p in range(0x400):
            row = [((p << 8) + x) in cells for x in range(256)]
            if not any(row):
                page_table += le(0xFFFF, 2)
                continue
            page_table += le(count, 2)
            count += 1
            pages += le(rank, 4) + sum(1 << x for x in range(256) if row[x]).to_bytes(32, 'little')
            for x in range(256):
                if row[x]:
                    values += le(cells[(p << 8) + x], width)
                    rank += 1
    suppressed = sorted(tailoring.suppressed)
    flags = tailoring.case_first | (4 if tailoring.backwards else 0) | (8 if tailoring.shifted else 0)
    head = bytearray(bytes([flags, len(tailoring.reorder)]) + le(len(suppressed), 2))
    for start, limit, delta in tailoring.reorder:
        head += le(start, 4) + le(limit, 4) + le(delta, 4)
    head += b''.join(le(c, 4) for c in suppressed)
    fields_at = len(head)
    head += bytes(4 * 14)
    parts = []
    def place(data):
        parts.append(data)
        at = len(head) + sum(len(p) for p in parts[:-1])
        return at
    entry_index_at = place(b''.join(le(o, 4) for o in entry_offsets))
    entries_at = place(entry_bytes)
    context_index_at = place(b''.join(le(o, 4) for o in context_offsets))
    contexts_at = place(context_bytes)
    chain_index_at = place(b''.join(le(o, 4) for o in chain_offsets))
    chains_at = place(chain_bytes)
    page_table_at = place(page_table)
    pages_at = place(pages)
    values_at = place(values)
    latin = latin_ces(Collator(root, tailoring))
    bits = 0
    latin_values = bytearray()
    for c in range(LATIN_LIMIT):
        if latin[c] != root_latin[c]:
            bits |= 1 << c
            latin_values += latin_bytes(latin[c])
    latin_bits_at = place(bits.to_bytes(LATIN_LIMIT // 8, 'little'))
    latin_values_at = place(bytes(latin_values))
    fields = [len(entries), len(contexts), len(chains), width, entry_index_at, entries_at,
              context_index_at, contexts_at, chain_index_at, chains_at, page_table_at, values_at,
              latin_bits_at, latin_values_at]
    head[fields_at:fields_at + 4 * len(fields)] = b''.join(le(v, 4) for v in fields)
    # pages and values follow the page table directly.
    assert pages_at == page_table_at + len(page_table) and values_at == pages_at + len(pages)
    return bytes(head) + b''.join(parts)




def literal(data):
    return 'b"' + ''.join(f'\\x{byte:02x}' for byte in data) + '"'


def digit_runs(root):
    """Decimal digits: (first code point, value of it, run length) from the root's Nd entries."""
    digits = {}
    primaries = sorted({root.raw[(c,)][0][0] for c in range(0x30, 0x3A)})
    for (c,), ces in ((k, v) for k, v in root.raw.items() if len(k) == 1):
        if unicodedata.category(chr(c)) == 'Nd' or (c in root.scripts and False):
            if len(ces) == 1 and ces[0][0] in primaries:
                digits[c] = primaries.index(ces[0][0])
    runs = []
    for c in sorted(digits):
        if runs and runs[-1][0] + runs[-1][2] == c and runs[-1][1] + runs[-1][2] == digits[c]:
            runs[-1][2] += 1
        else:
            runs.append([c, digits[c], 1])
    return runs


def generate(common):
    global COMMON_S, COMMON_T
    cldr = Cldr(common)
    root = cldr.root
    COMMON_S = root.common_s
    COMMON_T = root.common_t
    emitter = Emitter(cldr)
    tables = emitter.root_tables()
    han = emitter.han_tables()
    root_latin = latin_ces(Collator(root, cldr.build('root', 'standard')))
    records = bytearray()
    built = {}
    locale_rows = []
    for locale in sorted(cldr.rules):
        if locale in SKIPPED_LOCALES:
            continue
        entry = cldr.rules[locale]
        types = []
        for ctype in entry['types']:
            if ctype.startswith('private') or (locale, ctype) in SKIPPED_TYPES:
                continue
            tailoring = cldr.build(locale, ctype)
            data = encode_record(tailoring, root_latin, root)
            if data not in built:
                built[data] = len(records)
                records += data
                while len(records) % 4:
                    records.append(0)
            types.append((TYPE_IDS.index(ctype), built[data]))
        default = entry['default']
        locale_rows.append((locale, TYPE_IDS.index(default), types))
    locales = bytearray()
    locale_index = bytearray()
    assert [r[0] for r in locale_rows] == sorted(r[0] for r in locale_rows)
    for name, default, types in locale_rows:
        locale_index += le(len(locales), 4)
        locales += bytes([len(name)]) + name.encode() + bytes([default, len(types)])
        for t, offset in types:
            locales += bytes([t]) + le(offset, 4)
    st = bytearray()
    for s, t in emitter.st_list:
        st += le(s, 4) + le(t, 2)
    blocks = b''.join(le(a, 4) + le(b, 4) for a, b in HAN_BLOCKS)
    digits = b''.join(le(c, 4) + bytes([v, n]) + b'\0\0' for c, v, n in digit_runs(root))
    variable_limit = root.variable_top + (1 << P_SHIFT)
    lines = [
        '// Generated by scripts/generate_intl_collation.py; do not edit.',
        '// CLDR 48 root collation (common/uca/FractionalUCA.txt) and tailorings (common/collation/*.xml).',
        '// CLDR data: Unicode License V3, https://www.unicode.org/license.txt',
        '//! Tables read by `intl_collation`. Integers are little-endian.',
        '//! A collation element (CE) has a u32 primary, a u32 secondary and a u16 tertiary whose',
        '//! bits 14 and 15 are the case (0 lower, 1 mixed, 2 upper). Root weights are ranks:',
        '//! primary rank << 16, secondary rank << 16, tertiary rank << 8; tailorings use the gaps.',
        '//! A root CE word is primary rank << 16 | an index into `secondaryTertiary()`; rank 0xffff',
        '//! is a Han reference whose code point is the next word.',
        '',
        f'pub const COMMON_SECONDARY: u32 = {root.common_s}',
        f'pub const COMMON_TERTIARY: u32 = {root.common_t}',
        f'/// A primary below this (and not 0) is variable: space or punctuation.',
        f'pub const VARIABLE_LIMIT: u32 = {variable_limit}',
        f'pub const NUMERIC_PRIMARY: u32 = {root.numeric_base}',
        f'pub const HAN_PRIMARY: u32 = {HAN_BASE}',
        f'pub const UNASSIGNED_PRIMARY: u32 = {UNASSIGNED_BASE}',
        f'pub const FFFD_PRIMARY: u32 = {FFFD_PRIMARY}',
        f'pub const FFFF_PRIMARY: u32 = {FFFF_PRIMARY}',
        f'pub const LOCALE_COUNT: usize = {len(locale_rows)}',
        f'pub const LATIN_LIMIT: u32 = {LATIN_LIMIT}',
        f'pub const LATIN_BAIL: u32 = {LATIN_BAIL}',
        f'pub const CONTEXT_SEPARATOR: u32 = {CONTEXT_SEPARATOR}',
        '/// Code points from LATIN_LIMIT up, not combining marks, that continue a contraction',
        '/// of a code point the Latin tables cover.',
        '/// Every code point after the first of a contraction, sorted.',
        'pub const CONTINUATIONS: [u32; %d] = [%s]' % (len(CONTINUATION_SET), ', '.join(str(c) for c in sorted(CONTINUATION_SET))),
        'pub const LATIN_JOINERS: [u32; %d] = [%s]' % (len(LATIN_JOINER_SET), ', '.join(str(c) for c in sorted(LATIN_JOINER_SET))),
        f'pub const ITEM_COUNT: usize = {tables["item_count"]}',
        f'pub const CONTRACTION_COUNT: usize = {tables["contraction_count"]}',
        f'pub const PREFIX_COUNT: usize = {len(tables["prefix"]) // 10}',
        f'pub const HAN_INDEX_COUNT: usize = {len(han["han_index"]) // 12}',
        f'pub const DIGIT_RUN_COUNT: usize = {len(digits) // 8}',
        '/// Collation types by id, in the order the locale table uses.',
        'pub const TYPES: [string; %d] = [%s]' % (len(TYPE_IDS), ', '.join('"%s"' % t for t in TYPE_IDS)),
        '/// Per index: the u32 secondary and u16 tertiary of a root CE word.',
        "pub fn secondaryTertiary() -> &'static [u8] {",
        '  return ' + literal(st),
        '}',
        '/// Root code points by start, 8 bytes each: a u32 of start << 11 | flags << 8 | (length - 1)',
        '/// and a u32 value. Flags: bit 0 the value is pool offset << 8 | CE count (else it is the CE',
        '/// word of the first code point; the next ones add 1 to the primary rank), bit 1 a',
        '/// contraction starts here, bit 2 a prefix mapping may apply.',
        "pub fn items() -> &'static [u8] {",
        '  return ' + literal(tables['items']),
        '}',
        '/// CE words of the expanding items.',
        "pub fn pool() -> &'static [u8] {",
        '  return ' + literal(tables['pool']),
        '}',
        '/// u32 offsets into `contractions()`, sorted by code points.',
        "pub fn contractionIndex() -> &'static [u8] {",
        '  return ' + literal(tables['cindex']),
        '}',
        '/// Per contraction: u8 length, u24 code points, u8 CE count and its CE words.',
        "pub fn contractions() -> &'static [u8] {",
        '  return ' + literal(tables['contractions']),
        '}',
        '/// Per prefix mapping: u24 previous code point, u24 code point and the CE word.',
        "pub fn prefixes() -> &'static [u8] {",
        '  return ' + literal(tables['prefix']),
        '}',
        '/// The CE word of each ASCII code point.',
        "pub fn ascii() -> &'static [u8] {",
        '  return ' + literal(tables['ascii']),
        '}',
        '/// Per code point below LATIN_LIMIT, its root CEs for the fast paths, 20 bytes: two CEs of',
        '/// u32 primary, u32 secondary and u16 tertiary (all zero for a missing one), or LATIN_BAIL',
        '/// as the first primary when the code point needs the full path (more than two CEs, or a',
        '/// contraction or prefix mapping can join it with a neighbor).',
        "pub fn latinRoot() -> &'static [u8] {",
        '  return ' + literal(b''.join(latin_bytes(e) for e in root_latin)),
        '}',
        '/// The Han blocks in root order: u32 first and last code point.',
        "pub fn hanBlocks() -> &'static [u8] {",
        '  return ' + literal(blocks),
        '}',
        '/// Every 64th Han run: u32 first code point, u32 offset into `hanRuns()` and u32 segment.',
        "pub fn hanIndex() -> &'static [u8] {",
        '  return ' + literal(han['han_index']),
        '}',
        '/// Han runs of one radical-stroke segment in code point order, as LEB128 numbers: the gap',
        '/// from the end of the previous run, length - 1 and the zigzag segment change.',
        "pub fn hanRuns() -> &'static [u8] {",
        '  return ' + literal(han['han_runs']),
        '}',
        '/// Decimal digit runs: u32 first code point, u8 its value, u8 length and two pad bytes.',
        "pub fn digits() -> &'static [u8] {",
        '  return ' + literal(digits),
        '}',
        '/// Per locale with tailorings: u8 name length, the name (CLDR spelling), u8 default type,',
        '/// u8 type count and per type its id and the u32 offset of its record in `records()`.',
        "pub fn locales() -> &'static [u8] {",
        '  return ' + literal(locales),
        '}',
        '/// The u32 offset of each `locales()` row, in byte order of the names.',
        "pub fn localeIndex() -> &'static [u8] {",
        '  return ' + literal(locale_index),
        '}',
        '/// Tailoring records. A record: u8 flags (bits 0-1 caseFirst: 0 off, 1 lower, 2 upper; bit 2',
        '/// backwards secondary; bit 3 shifted), u8 reorder count, u16 suppressed count, the reorder',
        '/// ranges (u32 start, u32 limit, i32 delta of a primary), the u32 code points whose root',
        '/// contractions are suppressed, then fourteen u32 fields: entry, context and chain counts, the',
        '/// chain value width, and the offsets (from the record start) of the entry index, entries,',
        '/// context index, contexts, chain index, chains, page table, member values, Latin bits and',
        '/// Latin values. An index holds u32 offsets',
        '/// relative to its list, sorted by code points. An entry: u8 length, u24 code points (a',
        '/// context entry has its code points, CONTEXT_SEPARATOR, then the code points before them',
        '/// that it needs, nearest first), u8 CE count and the CEs. A CE is a',
        '/// u8 flag byte, a u32 primary, then a u32 secondary if flag bit 0 is set and a u16',
        '/// tertiary if bit 1 is set; a missing one is the common weight. A chain: u32 first member,',
        '/// u8 level, u8 CE count and the CEs; member n of the',
        '/// chain adds n to the last CE at that level. The page table has 1024 u16 slots (0xffff for',
        '/// none) per 256 code points; then the pages (u32 rank, 32 bytes of member bits) and per',
        '/// rank the member number in the value width. The Latin bits mark the code points below',
        '/// LATIN_LIMIT whose fast-path CEs differ from `latinRoot()`; their values follow in code',
        '/// point order, 20 bytes each, in the same form.',
        "pub fn records() -> &'static [u8] {",
        '  return ' + literal(records),
        '}',
        '',
    ]
    sizes = {k: len(v) for k, v in tables.items() if isinstance(v, bytes)}
    sizes.update({k: len(v) for k, v in han.items() if isinstance(v, bytes)})
    sizes['records'] = len(records)
    sizes['locales'] = len(locales)
    print('sizes', sizes, 'total', sum(sizes.values()), file=sys.stderr)
    return '\n'.join(lines)


if __name__ == '__main__':
    common = sys.argv[1]
    output = sys.argv[2]
    text = generate(common)
    with open(output, 'w') as f:
        f.write(text)
