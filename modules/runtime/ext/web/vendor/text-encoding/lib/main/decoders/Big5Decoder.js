/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const big5 = require("internal/web/vendor/text-encoding/data/big5.cp");
const { AbstractDecoder } = require("internal/web/vendor/text-encoding/lib/main/AbstractDecoder");
const { END_OF_BUFFER } = require("internal/web/vendor/text-encoding/lib/main/ByteBuffer");
const { FINISHED } = require("internal/web/vendor/text-encoding/lib/main/constants");
const { inRange, isASCII } = require("internal/web/vendor/text-encoding/lib/main/util");
/**
 * Decoder for big5 encoding.
 */
class Big5Decoder extends AbstractDecoder {
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
            this.lead = 0x00;
            const offset = byte < 0x7F ? 0x40 : 0x62;
            let index = null;
            if (inRange(byte, 0x40, 0x7E) || inRange(byte, 0xA1, 0xFE)) {
                index = (lead - 0x81) * 157 + (byte - offset);
            }
            switch (index) {
                case 1133: return [0x00CA, 0x0304];
                case 1135: return [0x00CA, 0x030C];
                case 1164: return [0x00EA, 0x0304];
                case 1166: return [0x00EA, 0x030C];
                case null:
                default:
            }
            const codePoint = (index == null) ? null : big5[index] || null;
            if (codePoint == null && isASCII(byte)) {
                buffer.write(byte);
            }
            return codePoint ?? this.fail();
        }
        if (isASCII(byte)) {
            return byte;
        }
        if (inRange(byte, 0x81, 0xFE)) {
            this.lead = byte;
            return null;
        }
        return this.fail();
    }
}

Object.assign(exports, { Big5Decoder });
