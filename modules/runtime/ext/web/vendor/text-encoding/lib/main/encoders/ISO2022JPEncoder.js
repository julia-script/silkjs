/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const iso2022jpKatakana = require("internal/web/vendor/text-encoding/data/iso-2022-jp-katakana.cp");
const { AbstractEncoder, NO_TRAILING_BYTES } = require("internal/web/vendor/text-encoding/lib/main/AbstractEncoder");
const { END_OF_BUFFER } = require("internal/web/vendor/text-encoding/lib/main/ByteBuffer");
const { FINISHED } = require("internal/web/vendor/text-encoding/lib/main/constants");
const { inRange, isASCII } = require("internal/web/vendor/text-encoding/lib/main/util");
const { getJIS0208Pointer } = require("internal/web/vendor/text-encoding/lib/main/encoders/JIS0208Index");
const State = {
    ASCII: 0,
    Roman: 1,
    jis0208: 2
};
const ASCII_ESCAPE = [0x1B, 0x28, 0x42];
/**
 * Encoder for iso-2022-jp encoding.
 */
class ISO2022JPEncoder extends AbstractEncoder {
    state = State.ASCII;
    /** @inheritdoc */
    getTrailingBytes() {
        return this.state === State.ASCII ? NO_TRAILING_BYTES : ASCII_ESCAPE;
    }
    /** @inheritdoc */
    encode(buffer) {
        let codePoint = buffer.read();
        if (codePoint === END_OF_BUFFER) {
            if (this.state === State.ASCII) {
                return FINISHED;
            }
            buffer.write(codePoint);
            this.state = State.ASCII;
            return [0x1B, 0x28, 0x42];
        }
        if ((this.state === State.ASCII || this.state === State.Roman)
            && (codePoint === 0x000E || codePoint === 0x000F || codePoint === 0x001B)) {
            return this.fail(0xFFFD);
        }
        if (this.state === State.ASCII && isASCII(codePoint)) {
            return codePoint;
        }
        if (this.state === State.Roman) {
            if (isASCII(codePoint) && codePoint !== 0x005C && codePoint !== 0x007E) {
                return codePoint;
            }
            if (codePoint === 0x00A5) {
                return 0x5C;
            }
            if (codePoint === 0x203E) {
                return 0x7E;
            }
        }
        if (isASCII(codePoint) && this.state !== State.ASCII) {
            buffer.write(codePoint);
            this.state = State.ASCII;
            return [0x1B, 0x28, 0x42];
        }
        if ((codePoint === 0x00A5 || codePoint === 0x203E) && this.state !== State.Roman) {
            buffer.write(codePoint);
            this.state = State.Roman;
            return [0x1B, 0x28, 0x4A];
        }
        if (codePoint === 0x2212) {
            codePoint = 0xFF0D;
        }
        if (inRange(codePoint, 0xFF61, 0xFF9F)) {
            codePoint = iso2022jpKatakana[codePoint - 0xFF61];
        }
        const index = getJIS0208Pointer(codePoint);
        if (index == null) {
            return this.fail(codePoint);
        }
        if (this.state !== State.jis0208) {
            buffer.write(codePoint);
            this.state = State.jis0208;
            return [0x1B, 0x24, 0x42];
        }
        const lead = Math.floor(index / 94) + 0x21;
        const trail = index % 94 + 0x21;
        return [lead, trail];
    }
}

Object.assign(exports, { ISO2022JPEncoder });
