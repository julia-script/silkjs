/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const jis0208 = require("internal/web/vendor/text-encoding/data/jis0208.cp");
const jis0212 = require("internal/web/vendor/text-encoding/data/jis0212.cp");
const { AbstractDecoder } = require("internal/web/vendor/text-encoding/lib/main/AbstractDecoder");
const { END_OF_BUFFER } = require("internal/web/vendor/text-encoding/lib/main/ByteBuffer");
const { FINISHED } = require("internal/web/vendor/text-encoding/lib/main/constants");
const { inRange, isASCII } = require("internal/web/vendor/text-encoding/lib/main/util");
/**
 * Decoder for euc-jp encoding.
 */
class EUCJPDecoder extends AbstractDecoder {
    jis0212Flag = false;
    lead = 0x00;
    /** @inheritdoc */
    decode(buffer) {
        const byte = buffer.read();
        if (byte === END_OF_BUFFER) {
            const incomplete = this.lead !== 0x00;
            this.lead = 0x00;
            this.jis0212Flag = false;
            return incomplete ? this.fail() : FINISHED;
        }
        if (this.lead === 0x8E && inRange(byte, 0xA1, 0xDF)) {
            this.lead = 0x00;
            return 0xFF61 - 0xA1 + byte;
        }
        if (this.lead === 0x8F && inRange(byte, 0xA1, 0xFE)) {
            this.jis0212Flag = true;
            this.lead = byte;
            return null;
        }
        if (this.lead !== 0x00) {
            const lead = this.lead;
            this.lead = 0x00;
            let codePoint = null;
            if (inRange(lead, 0xA1, 0xFE) && inRange(byte, 0xA1, 0xFE)) {
                codePoint = (this.jis0212Flag ? jis0212 : jis0208)[(lead - 0xA1) * 94 + (byte - 0xA1)] || null;
            }
            this.jis0212Flag = false;
            if (!inRange(byte, 0xA1, 0xFE)) {
                buffer.write(byte);
            }
            return codePoint ?? this.fail();
        }
        if (isASCII(byte)) {
            return byte;
        }
        if (byte === 0x8E || byte === 0x8F || inRange(byte, 0xA1, 0xFE)) {
            this.lead = byte;
            return null;
        }
        return this.fail();
    }
}

Object.assign(exports, { EUCJPDecoder });
