/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
/**
 * Base class for decoders.
 */
class AbstractDecoder {
    /** True to throw an exception when a character can't be decoded. False to decode to a replacement character instead. */
    fatal;
    /**
     * @param fatal - True to throw an exception when a character can't be decoded. False to decode to a
     *                replacement character instead.
     */
    constructor(fatal = false) {
        this.fatal = fatal;
    }
    /**
     * Fails the decoding by throwing an exception (if fatal flag is true) or returning a replacement character.
     *
     * @returns Replacement character to use for the character which could not be decoded.
     * @throws TypeError - When fatal flag is set to true.
     */
    fail() {
        if (this.fatal) {
            throw new TypeError("Decoder error");
        }
        return 0xFFFD;
    }
}

Object.assign(exports, { AbstractDecoder });
