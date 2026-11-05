/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
/** Special value returned when end of the buffer has been hit. */
const END_OF_BUFFER = -1;
/**
 * A byte buffer which allows bytes to be read and restored.
 */
class ByteBuffer {
    /** The input bytes. */
    bytes;
    /** Current position in the input bytes. */
    position = 0;
    /** Bytes which have been written back to the buffer. */
    restoredBytes = [];
    /**
     * Creates a new byte buffer backed by the given byte array.
     *
     * @param bytes - Array of initial bytes in the buffer.
     */
    constructor(bytes) {
        this.bytes = bytes;
    }
    /**
     * Checks if end of buffer has been hit.
     *
     * @returns True if end of buffer, false if not.
     */
    isEndOfBuffer() {
        return this.position >= this.bytes.length && this.restoredBytes.length === 0;
    }
    /**
     * Reads the next byte from the buffer and returns it. END_OF_BUFFER is returned when there are no more bytes to
     * read.
     *
     * @returns The read byte or END_OF_BUFFER when no more bytes to read.
     */
    read() {
        return this.restoredBytes.pop() ?? this.bytes[this.position++] ?? END_OF_BUFFER;
    }
    /**
     * Restores the specified bytes so they are returned by the next reads in the given order.
     *
     * @param bytes - The bytes to restore.
     */
    write(...bytes) {
        for (let index = bytes.length - 1; index >= 0; --index) {
            this.restoredBytes.push(bytes[index]);
        }
    }
}

Object.assign(exports, { END_OF_BUFFER, ByteBuffer });
