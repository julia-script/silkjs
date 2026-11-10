/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const { AbstractEncoder } = require("internal/web/vendor/text-encoding/lib/main/AbstractEncoder");
const { END_OF_BUFFER } = require("internal/web/vendor/text-encoding/lib/main/ByteBuffer");
const { FINISHED } = require("internal/web/vendor/text-encoding/lib/main/constants");
const { convertCodeUnitToBytes, inRange } = require("internal/web/vendor/text-encoding/lib/main/util");
/**
 * Base class for utf-16 encoders.
 */
class UTF16Encoder extends AbstractEncoder {
    bigEndian;
    /**
     * @param bigEndian - True for utf-16be, false for utf-16le
     */
    constructor(bigEndian) {
        super();
        this.bigEndian = bigEndian;
    }
    /** @inheritdoc */
    encode(buffer) {
        const codePoint = buffer.read();
        if (codePoint === END_OF_BUFFER) {
            return FINISHED;
        }
        if (inRange(codePoint, 0x0000, 0xFFFF)) {
            return convertCodeUnitToBytes(codePoint, this.bigEndian);
        }
        const lead = convertCodeUnitToBytes(((codePoint - 0x10000) >> 10) + 0xD800, this.bigEndian);
        const trail = convertCodeUnitToBytes(((codePoint - 0x10000) & 0x3FF) + 0xDC00, this.bigEndian);
        return lead.concat(trail);
    }
}
/**
 * Encoder for utf-16le encoding.
 */
class UTF16LEEncoder extends UTF16Encoder {
    /** @inheritdoc */
    constructor() {
        super(false);
    }
}
/**
 * Encoder for utf-16be encoding.
 */
class UTF16BEEncoder extends UTF16Encoder {
    /** @inheritdoc */
    constructor() {
        super(true);
    }
}

Object.assign(exports, { UTF16Encoder, UTF16LEEncoder, UTF16BEEncoder });
