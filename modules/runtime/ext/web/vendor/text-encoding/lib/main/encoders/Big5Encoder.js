/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const big5 = require("internal/web/vendor/text-encoding/data/big5.cp");
const { AbstractEncoder } = require("internal/web/vendor/text-encoding/lib/main/AbstractEncoder");
const { END_OF_BUFFER } = require("internal/web/vendor/text-encoding/lib/main/ByteBuffer");
const { FINISHED } = require("internal/web/vendor/text-encoding/lib/main/constants");
const { isASCII } = require("internal/web/vendor/text-encoding/lib/main/util");
const { CodePointIndex } = require("internal/web/vendor/text-encoding/lib/main/encoders/CodePointIndex");
const BIG5_INDEX_START = (0xA1 - 0x81) * 157;
const BIG5_LAST_POINTER_CODE_POINTS = [0x2550, 0x255E, 0x2561, 0x256A, 0x5341, 0x5345];
let big5Index = null;
/**
 * Returns the index for the given code point.
 *
 * @param codePoint - The code point to search for.
 * @returns The found index or null if not found.
 */
function getIndex(codePoint) {
    if (big5Index == null) {
        big5Index = new CodePointIndex(big5, BIG5_INDEX_START);
        for (const lastPointerCodePoint of BIG5_LAST_POINTER_CODE_POINTS) {
            big5Index.setBMP(lastPointerCodePoint, big5.lastIndexOf(lastPointerCodePoint));
        }
    }
    return big5Index.get(codePoint);
}
/**
 * Encoder for big5 encoding.
 */
class Big5Encoder extends AbstractEncoder {
    /** @inheritdoc */
    encode(buffer) {
        const codePoint = buffer.read();
        if (codePoint === END_OF_BUFFER) {
            return FINISHED;
        }
        if (isASCII(codePoint)) {
            return codePoint;
        }
        const index = getIndex(codePoint);
        if (index == null) {
            return this.fail(codePoint);
        }
        const lead = Math.floor(index / 157) + 0x81;
        const trail = index % 157;
        const offset = trail < 0x3F ? 0x40 : 0x62;
        return [lead, trail + offset];
    }
}

Object.assign(exports, { Big5Encoder });
