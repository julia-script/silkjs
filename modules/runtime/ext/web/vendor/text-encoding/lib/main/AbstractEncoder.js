/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const NO_TRAILING_BYTES = [];
/**
 * Base class for encoders.
 */
class AbstractEncoder {
    /** @inheritdoc */
    getTrailingBytes() {
        return NO_TRAILING_BYTES;
    }
    /**
     * Fails the encoding by throwing an exception
     *
     * @param codePoint - The code point which could not be encoded.
     */
    fail(codePoint) {
        throw new TypeError(`The code point ${codePoint} could not be encoded`);
    }
}

Object.assign(exports, { NO_TRAILING_BYTES, AbstractEncoder });
