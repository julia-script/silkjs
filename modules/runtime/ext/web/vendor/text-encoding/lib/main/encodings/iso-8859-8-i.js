/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const iso88598 = require("internal/web/vendor/text-encoding/data/iso-8859-8.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("iso-8859-8-i", [
    "csiso88598i",
    "iso-8859-8-i",
    "logical"
], SingleByteDecoder.forCodePoints(iso88598), SingleByteEncoder.forCodePoints(iso88598));
