/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const jis0208 = require("internal/web/vendor/text-encoding/data/jis0208.cp");
const { AbstractDecoder } = require("internal/web/vendor/text-encoding/lib/main/AbstractDecoder");
const { END_OF_BUFFER } = require("internal/web/vendor/text-encoding/lib/main/ByteBuffer");
const { FINISHED } = require("internal/web/vendor/text-encoding/lib/main/constants");
const { inRange } = require("internal/web/vendor/text-encoding/lib/main/util");
const State = {
    ASCII: 0,
    Roman: 1,
    Katakana: 2,
    LeadByte: 3,
    TrailByte: 4,
    EscapeStart: 5,
    Escape: 6
};
/**
 * Decoder for iso-2022-jp encoding.
 */
class ISO2022JPDecoder extends AbstractDecoder {
    state = State.ASCII;
    outputState = State.ASCII;
    lead = 0x00;
    outputFlag = false;
    /**
     * Decodes a byte while the decoder is not in the ASCII state.
     *
     * @param buffer - The byte buffer to decode.
     * @param byte   - The byte to decode.
     * @param state  - The current non-ASCII decoder state.
     * @returns The decoded code point(s), or null if more bytes are needed.
     */
    decodeNonASCII(buffer, byte, state) {
        switch (state) {
            case State.Roman:
                if (byte === 0x1B) {
                    this.state = State.EscapeStart;
                    return null;
                }
                if (byte === 0x5C) {
                    this.outputFlag = false;
                    return 0x00A5;
                }
                if (byte === 0x7E) {
                    this.outputFlag = false;
                    return 0x203E;
                }
                if (inRange(byte, 0x00, 0x7F) && byte !== 0x0E && byte !== 0x0F) {
                    this.outputFlag = false;
                    return byte;
                }
                if (byte === END_OF_BUFFER) {
                    return FINISHED;
                }
                this.outputFlag = false;
                return this.fail();
            case State.Katakana:
                if (byte === 0x1B) {
                    this.state = State.EscapeStart;
                    return null;
                }
                if (inRange(byte, 0x21, 0x5F)) {
                    this.outputFlag = false;
                    return 0xFF61 - 0x21 + byte;
                }
                if (byte === END_OF_BUFFER) {
                    return FINISHED;
                }
                this.outputFlag = false;
                return this.fail();
            case State.LeadByte:
                if (byte === 0x1B) {
                    this.state = State.EscapeStart;
                    return null;
                }
                if (inRange(byte, 0x21, 0x7E)) {
                    this.outputFlag = false;
                    this.lead = byte;
                    this.state = State.TrailByte;
                    return null;
                }
                if (byte === END_OF_BUFFER) {
                    return FINISHED;
                }
                this.outputFlag = false;
                return this.fail();
            case State.TrailByte:
                if (byte === 0x1B) {
                    this.state = State.EscapeStart;
                    return this.fail();
                }
                if (inRange(byte, 0x21, 0x7E)) {
                    this.state = State.LeadByte;
                    const index = (this.lead - 0x21) * 94 + byte - 0x21;
                    const codePoint = jis0208[index] || null;
                    if (codePoint == null) {
                        return this.fail();
                    }
                    return codePoint;
                }
                if (byte === END_OF_BUFFER) {
                    this.state = State.LeadByte;
                    return this.fail();
                }
                this.state = State.LeadByte;
                return this.fail();
            case State.EscapeStart:
                if (byte === 0x24 || byte === 0x28) {
                    this.lead = byte;
                    this.state = State.Escape;
                    return null;
                }
                if (byte !== END_OF_BUFFER) {
                    buffer.write(byte);
                }
                this.outputFlag = false;
                this.state = this.outputState;
                return this.fail();
            case State.Escape: {
                const lead = this.lead;
                this.lead = 0x00;
                let state = null;
                if (lead === 0x28 && byte === 0x42) {
                    state = State.ASCII;
                }
                else if (lead === 0x28 && byte === 0x4A) {
                    state = State.Roman;
                }
                else if (lead === 0x28 && byte === 0x49) {
                    state = State.Katakana;
                }
                else if (lead === 0x24 && (byte === 0x40 || byte === 0x42)) {
                    state = State.LeadByte;
                }
                if (state !== null) {
                    this.state = state;
                    this.outputState = state;
                    const outputFlag = this.outputFlag;
                    this.outputFlag = true;
                    return !outputFlag ? null : this.fail();
                }
                if (byte === END_OF_BUFFER) {
                    buffer.write(lead);
                }
                else {
                    buffer.write(lead, byte);
                }
                this.outputFlag = false;
                this.state = this.outputState;
                return this.fail();
            }
        }
    }
    /** @inheritdoc */
    decode(buffer) {
        const byte = buffer.read();
        if (this.state !== State.ASCII) {
            return this.decodeNonASCII(buffer, byte, this.state);
        }
        if (byte === 0x1B) {
            this.state = State.EscapeStart;
            return null;
        }
        if (inRange(byte, 0x00, 0x7F) && byte !== 0x0E && byte !== 0x0F) {
            this.outputFlag = false;
            return byte;
        }
        if (byte === END_OF_BUFFER) {
            return FINISHED;
        }
        this.outputFlag = false;
        return this.fail();
    }
}

Object.assign(exports, { ISO2022JPDecoder });
