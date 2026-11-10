/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const { AbstractEncoder } = require("internal/web/vendor/text-encoding/lib/main/AbstractEncoder");
const { END_OF_BUFFER } = require("internal/web/vendor/text-encoding/lib/main/ByteBuffer");
const { FINISHED } = require("internal/web/vendor/text-encoding/lib/main/constants");
const { inRange, isASCII } = require("internal/web/vendor/text-encoding/lib/main/util");
const { getShiftJISPointer } = require("internal/web/vendor/text-encoding/lib/main/encoders/JIS0208Index");
/**
 * Encoder for shift_jis encoding.
 */
class ShiftJISEncoder extends AbstractEncoder {
    /** @inheritdoc */
    encode(buffer) {
        let codePoint = buffer.read();
        if (codePoint === END_OF_BUFFER) {
            return FINISHED;
        }
        if (isASCII(codePoint) || codePoint === 0x0080) {
            return codePoint;
        }
        if (codePoint === 0x00A5) {
            return 0x5C;
        }
        if (codePoint === 0x203E) {
            return 0x7E;
        }
        if (inRange(codePoint, 0xFF61, 0xFF9F)) {
            return codePoint - 0xFF61 + 0xA1;
        }
        if (codePoint === 0x2212) {
            codePoint = 0xFF0D;
        }
        const index = getShiftJISPointer(codePoint);
        if (index == null) {
            return this.fail(codePoint);
        }
        const lead = Math.floor(index / 188);
        const leadOffset = (lead < 0x1F) ? 0x81 : 0xC1;
        const trail = index % 188;
        const offset = (trail < 0x3F) ? 0x40 : 0x41;
        return [lead + leadOffset, trail + offset];
    }
}

Object.assign(exports, { ShiftJISEncoder });
