/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const gb18030 = require("internal/web/vendor/text-encoding/data/gb18030.cp");
const gb18030ranges = require("internal/web/vendor/text-encoding/data/gb18030.ranges");
const { AbstractDecoder } = require("internal/web/vendor/text-encoding/lib/main/AbstractDecoder");
const { END_OF_BUFFER } = require("internal/web/vendor/text-encoding/lib/main/ByteBuffer");
const { FINISHED } = require("internal/web/vendor/text-encoding/lib/main/constants");
const { inRange, isASCII } = require("internal/web/vendor/text-encoding/lib/main/util");
/**
 * Returns the code point for the given gb18030 index.
 *
 * @param index - The index in the gb18030 code point table.
 * @returns The code point corresponding to the given index.
 */
function getCodePoint(index) {
    if ((index > 39419 && index < 189000) || (index > 1237575)) {
        return null;
    }
    if (index >= 189000) {
        return 0x10000 + index - 189000;
    }
    if (index === 7457) {
        return 0xE7C7;
    }
    let lower = 0;
    let upper = gb18030ranges.length - 1;
    while (lower < upper) {
        const middle = (lower + upper + 1) >> 1;
        if (gb18030ranges[middle][0] <= index) {
            lower = middle;
        }
        else {
            upper = middle - 1;
        }
    }
    const [pointerOffset, codePointOffset] = gb18030ranges[lower];
    return codePointOffset + index - pointerOffset;
}
/**
 * Decoder for gb18030 and gbk encoding.
 */
class GBDecoder extends AbstractDecoder {
    first = 0x00;
    second = 0x00;
    third = 0x00;
    /**
     * Decodes a byte while a multi-byte sequence is pending.
     *
     * @param buffer - The byte buffer to decode.
     * @param byte   - The byte to decode.
     * @returns The decoded code point, or null if more bytes are needed.
     */
    decodePending(buffer, byte) {
        if (this.third !== 0x00) {
            if (!inRange(byte, 0x30, 0x39)) {
                buffer.write(this.second, this.third, byte);
                this.first = 0x00;
                this.second = 0x00;
                this.third = 0x00;
                return this.fail();
            }
            const codePoint = getCodePoint((((this.first - 0x81) * 10 + this.second - 0x30) * 126 + this.third - 0x81)
                * 10 + byte - 0x30);
            this.first = 0x00;
            this.second = 0x00;
            this.third = 0x00;
            return codePoint ?? this.fail();
        }
        if (this.second !== 0x00) {
            if (inRange(byte, 0x81, 0xFE)) {
                this.third = byte;
                return null;
            }
            buffer.write(this.second, byte);
            this.first = 0x00;
            this.second = 0x00;
            return this.fail();
        }
        if (inRange(byte, 0x30, 0x39)) {
            this.second = byte;
            return null;
        }
        const lead = this.first;
        this.first = 0x00;
        if (inRange(byte, 0x40, 0x7E) || inRange(byte, 0x80, 0xFE)) {
            const offset = byte < 0x7F ? 0x40 : 0x41;
            return gb18030[(lead - 0x81) * 190 + (byte - offset)];
        }
        if (isASCII(byte)) {
            buffer.write(byte);
        }
        return this.fail();
    }
    /** @inheritdoc */
    decode(buffer) {
        const byte = buffer.read();
        if (byte === END_OF_BUFFER) {
            if (this.first === 0x00) {
                return FINISHED;
            }
            this.first = 0x00;
            this.second = 0x00;
            this.third = 0x00;
            return this.fail();
        }
        if (this.first !== 0x00) {
            return this.decodePending(buffer, byte);
        }
        if (isASCII(byte)) {
            return byte;
        }
        if (byte === 0x80) {
            return 0x20AC;
        }
        if (inRange(byte, 0x81, 0xFE)) {
            this.first = byte;
            return null;
        }
        return this.fail();
    }
}

Object.assign(exports, { GBDecoder });
