/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const { AbstractDecoder } = require("internal/web/vendor/text-encoding/lib/main/AbstractDecoder");
const { END_OF_BUFFER } = require("internal/web/vendor/text-encoding/lib/main/ByteBuffer");
const { FINISHED } = require("internal/web/vendor/text-encoding/lib/main/constants");
const { convertCodeUnitToBytes, inRange } = require("internal/web/vendor/text-encoding/lib/main/util");
/**
 * Base class for UTF-16 decoders.
 */
class UTF16Decoder extends AbstractDecoder {
    bigEndian;
    leadByte = null;
    leadSurrogate = null;
    /**
     * @param bigEndian - True for utf-16be, false for utf-16le.
     * @param fatal     - True to throw an exception when a character can't be decoded. False to decode to a
     *                    replacement character instead.
     */
    constructor(bigEndian, fatal) {
        super(fatal);
        this.bigEndian = bigEndian;
    }
    /** @inheritdoc */
    decode(buffer) {
        const byte = buffer.read();
        if (byte === END_OF_BUFFER) {
            if (this.leadByte !== null || this.leadSurrogate !== null) {
                return this.fail();
            }
            return FINISHED;
        }
        if (this.leadByte == null) {
            this.leadByte = byte;
            return null;
        }
        const codeUnit = this.bigEndian ? (this.leadByte << 8) + byte : (byte << 8) + this.leadByte;
        this.leadByte = null;
        if (this.leadSurrogate !== null) {
            const leadSurrogate = this.leadSurrogate;
            this.leadSurrogate = null;
            if (inRange(codeUnit, 0xDC00, 0xDFFF)) {
                return 0x10000 + (leadSurrogate - 0xD800) * 0x400 + (codeUnit - 0xDC00);
            }
            buffer.write(...convertCodeUnitToBytes(codeUnit, this.bigEndian));
            return this.fail();
        }
        if (inRange(codeUnit, 0xD800, 0xDBFF)) {
            this.leadSurrogate = codeUnit;
            return null;
        }
        if (inRange(codeUnit, 0xDC00, 0xDFFF)) {
            return this.fail();
        }
        return codeUnit;
    }
}
/**
 * Decoder for utf-16le encoding.
 */
class UTF16LEDecoder extends UTF16Decoder {
    /** @inheritdoc */
    constructor(fatal) {
        super(false, fatal);
    }
}
/**
 * Decoder for utf-16be encoding.
 */
class UTF16BEDecoder extends UTF16Decoder {
    /** @inheritdoc */
    constructor(fatal) {
        super(true, fatal);
    }
}

Object.assign(exports, { UTF16Decoder, UTF16LEDecoder, UTF16BEDecoder });
