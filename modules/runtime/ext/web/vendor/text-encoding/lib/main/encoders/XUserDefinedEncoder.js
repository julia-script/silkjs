/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const { AbstractEncoder } = require("internal/web/vendor/text-encoding/lib/main/AbstractEncoder");
const { END_OF_BUFFER } = require("internal/web/vendor/text-encoding/lib/main/ByteBuffer");
const { FINISHED } = require("internal/web/vendor/text-encoding/lib/main/constants");
const { inRange, isASCII } = require("internal/web/vendor/text-encoding/lib/main/util");
/**
 * Encoder for x-user-defined encoding.
 */
class XUserDefinedEncoder extends AbstractEncoder {
    /** @inheritdoc */
    encode(buffer) {
        const codePoint = buffer.read();
        if (codePoint === END_OF_BUFFER) {
            return FINISHED;
        }
        if (isASCII(codePoint)) {
            return codePoint;
        }
        if (inRange(codePoint, 0xF780, 0xF7FF)) {
            return codePoint - 0xF780 + 0x80;
        }
        return this.fail(codePoint);
    }
}

Object.assign(exports, { XUserDefinedEncoder });
