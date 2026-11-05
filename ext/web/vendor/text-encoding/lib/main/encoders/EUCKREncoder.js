/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const euckr = require("internal/web/vendor/text-encoding/data/euc-kr.cp");
const { AbstractEncoder } = require("internal/web/vendor/text-encoding/lib/main/AbstractEncoder");
const { END_OF_BUFFER } = require("internal/web/vendor/text-encoding/lib/main/ByteBuffer");
const { FINISHED } = require("internal/web/vendor/text-encoding/lib/main/constants");
const { isASCII } = require("internal/web/vendor/text-encoding/lib/main/util");
const { CodePointIndex } = require("internal/web/vendor/text-encoding/lib/main/encoders/CodePointIndex");
let euckrIndex = null;
/**
 * Returns the EUC-KR pointer for the given code point.
 *
 * @param codePoint - Code point to look up.
 * @returns The pointer or null if the code point is not indexed.
 */
function getIndex(codePoint) {
    euckrIndex ??= new CodePointIndex(euckr);
    return euckrIndex.get(codePoint);
}
/**
 * Encoder for euc-kr encoding.
 */
class EUCKREncoder extends AbstractEncoder {
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
        const lead = Math.floor(index / 190) + 0x81;
        const trail = (index % 190) + 0x41;
        return [lead, trail];
    }
}

Object.assign(exports, { EUCKREncoder });
