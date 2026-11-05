/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
/** Map with registered encodings. Map key is any lower-cased encoding label. */
const encodings = new Map();
/**
 * Registers an encoding.
 *
 * @param name    - The encoding name.
 * @param labels  - The list of encoding labels.
 * @param decoder - The constructor of the decoder which can decode this encoding.
 * @param encoder - The constructor of the encoder which can encode this encoding.
 * @returns The created and registered encoding.
 */
function registerEncoding(name, labels, decoder, encoder) {
    const encoding = new Encoding(name, decoder, encoder);
    for (const label of labels) {
        encodings.set(label, encoding);
    }
    return encoding;
}
/**
 * Returns the encoding for the specified label.
 *
 * @param label - The label of the encoding to look for.
 * @returns The found encoding.
 * @throws RangeError - When encoding was not found.
 */
function getEncoding(label) {
    const encoding = encodings.get(label.trim().toLowerCase());
    if (encoding == null) {
        throw new RangeError(`Encoding not supported: ${label}`);
    }
    return encoding;
}
/**
 * Encoding.
 */
class Encoding {
    /** The encoding name. */
    name;
    /** The constructor of the decoder which can decode this encoding. */
    decoder;
    /** The constructor of the encoder which can encode this encoding. */
    encoder;
    /**
     * Creates a new encoding.
     *
     * @param name - The encoding name.
     * @param decoder - The constructor of the decoder which can decode this encoding.
     * @param encoder - The constructor of the encoder which can encode this encoding.
     */
    constructor(name, decoder, encoder) {
        this.name = name;
        this.decoder = decoder;
        this.encoder = encoder;
    }
    /**
     * Returns the encoding name.
     *
     * @returns The encoding name.
     */
    getName() {
        return this.name;
    }
    /**
     * Creates a new decoder for this encoding.
     *
     * @param fatal - True to throw exception on decoding errors, false to use replacement characters instead for
     *                characters which can't be decoded.
     * @returns The created decoder.
     */
    createDecoder(fatal) {
        return new this.decoder(fatal);
    }
    /**
     * Creates a new encoder for this encoding.
     *
     * @returns The created encoder.
     */
    createEncoder() {
        return new this.encoder();
    }
}

Object.assign(exports, { registerEncoding, getEncoding, Encoding });
