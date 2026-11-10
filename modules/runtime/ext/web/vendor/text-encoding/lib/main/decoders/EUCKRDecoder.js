/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const euckr = require("internal/web/vendor/text-encoding/data/euc-kr.cp");
const { AbstractDecoder } = require("internal/web/vendor/text-encoding/lib/main/AbstractDecoder");
const { END_OF_BUFFER } = require("internal/web/vendor/text-encoding/lib/main/ByteBuffer");
const { FINISHED } = require("internal/web/vendor/text-encoding/lib/main/constants");
const { inRange, isASCII } = require("internal/web/vendor/text-encoding/lib/main/util");
/**
 * Decoder for euc-kr encoding.
 */
class EUCKRDecoder extends AbstractDecoder {
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
            if (inRange(byte, 0x41, 0xFE)) {
                index = (lead - 0x81) * 190 + (byte - 0x41);
            }
            const codePoint = (index == null) ? null : euckr[index] || null;
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

Object.assign(exports, { EUCKRDecoder });
