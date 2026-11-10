/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const jis0208 = require("internal/web/vendor/text-encoding/data/jis0208.cp");
const { AbstractDecoder } = require("internal/web/vendor/text-encoding/lib/main/AbstractDecoder");
const { END_OF_BUFFER } = require("internal/web/vendor/text-encoding/lib/main/ByteBuffer");
const { FINISHED } = require("internal/web/vendor/text-encoding/lib/main/constants");
const { inRange, isASCII } = require("internal/web/vendor/text-encoding/lib/main/util");
/**
 * Decoder for shift_jis encoding.
 */
class ShiftJISDecoder extends AbstractDecoder {
    lead = 0x00;
    /** @inheritdoc */
    decode(buffer) {
        const byte = buffer.read();
        if (byte === END_OF_BUFFER) {
            if (this.lead !== 0x00) {
                this.lead = 0x00;
                return this.fail();
            }
            return FINISHED;
        }
        if (this.lead !== 0x00) {
            const lead = this.lead;
            let index = null;
            this.lead = 0x00;
            const offset = (byte < 0x7F) ? 0x40 : 0x41;
            const leadOffset = (lead < 0xA0) ? 0x81 : 0xC1;
            if (inRange(byte, 0x40, 0x7E) || inRange(byte, 0x80, 0xFC)) {
                index = (lead - leadOffset) * 188 + byte - offset;
            }
            if (index != null && inRange(index, 8836, 10715)) {
                return 0xE000 - 8836 + index;
            }
            const codePoint = (index == null) ? null : jis0208[index] || null;
            if (codePoint == null && isASCII(byte)) {
                buffer.write(byte);
            }
            return codePoint ?? this.fail();
        }
        if (isASCII(byte) || byte === 0x80) {
            return byte;
        }
        if (inRange(byte, 0xA1, 0xDF)) {
            return 0xFF61 - 0xA1 + byte;
        }
        if (inRange(byte, 0x81, 0x9F) || inRange(byte, 0xE0, 0xFC)) {
            this.lead = byte;
            return null;
        }
        return this.fail();
    }
}

Object.assign(exports, { ShiftJISDecoder });
