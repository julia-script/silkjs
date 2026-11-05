/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const { AbstractEncoder } = require("internal/web/vendor/text-encoding/lib/main/AbstractEncoder");
const { END_OF_BUFFER } = require("internal/web/vendor/text-encoding/lib/main/ByteBuffer");
const { FINISHED } = require("internal/web/vendor/text-encoding/lib/main/constants");
const { isASCII } = require("internal/web/vendor/text-encoding/lib/main/util");
/**
 * Encoder for single byte encodings.
 */
class SingleByteEncoder extends AbstractEncoder {
    getIndex;
    /**
     * Constructs new encoder for the given code points.
     *
     * @param getIndex - Function returning the encoding pointer for a code point.
     */
    constructor(getIndex) {
        super();
        this.getIndex = getIndex;
    }
    /**
     * Creates and returns a single byte encoder class for the given code points.
     *
     * @param codePoints - The code points of the encoding to encode.
     * @returns The created single byte encoder class.
     */
    static forCodePoints(codePoints) {
        let index = null;
        const getIndex = (codePoint) => {
            if (index == null) {
                index = new Map();
                for (let pointer = 0; pointer < codePoints.length; ++pointer) {
                    const indexedCodePoint = codePoints[pointer];
                    if (indexedCodePoint != null && indexedCodePoint !== 0 && !index.has(indexedCodePoint)) {
                        index.set(indexedCodePoint, pointer);
                    }
                }
            }
            return index.get(codePoint) ?? null;
        };
        return class extends SingleByteEncoder {
            constructor() {
                super(getIndex);
            }
        };
    }
    /** @inheritdoc */
    encode(buffer) {
        const codePoint = buffer.read();
        if (codePoint === END_OF_BUFFER) {
            return FINISHED;
        }
        if (isASCII(codePoint)) {
            return codePoint;
        }
        const index = this.getIndex(codePoint);
        if (index == null) {
            return this.fail(codePoint);
        }
        return index + 0x80;
    }
}

Object.assign(exports, { SingleByteEncoder });
