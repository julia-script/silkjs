/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const { AbstractDecoder } = require("internal/web/vendor/text-encoding/lib/main/AbstractDecoder");
const { END_OF_BUFFER } = require("internal/web/vendor/text-encoding/lib/main/ByteBuffer");
const { FINISHED } = require("internal/web/vendor/text-encoding/lib/main/constants");
const { isASCII } = require("internal/web/vendor/text-encoding/lib/main/util");
/**
 * Decoder for single byte encodings.
 */
class SingleByteDecoder extends AbstractDecoder {
    index;
    /**
     * Constructs new decoder for the given code points.
     *
     * @param codePoints - The code points of the encoding.
     * @param fatal      - True to throw an exception when a character can't be decoded. False to decode to a
     *                     replacement character instead.
     */
    constructor(codePoints, fatal) {
        super(fatal);
        this.index = codePoints;
    }
    /**
     * Creates and returns a single byte decoder class for the given code points.
     *
     * @param codePoints - The code points of the encoding to decode.
     * @returns The created single byte decoder class.
     */
    static forCodePoints(codePoints) {
        return class extends SingleByteDecoder {
            constructor(fatal) {
                super(codePoints, fatal);
            }
        };
    }
    /** @inheritdoc */
    decode(buffer) {
        const byte = buffer.read();
        if (byte === END_OF_BUFFER) {
            return FINISHED;
        }
        if (isASCII(byte)) {
            return byte;
        }
        return this.index[byte - 0x80] || this.fail();
    }
}

Object.assign(exports, { SingleByteDecoder });
