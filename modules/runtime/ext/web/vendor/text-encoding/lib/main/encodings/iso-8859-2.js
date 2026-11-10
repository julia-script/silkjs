/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const iso88592 = require("internal/web/vendor/text-encoding/data/iso-8859-2.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("iso-8859-2", [
    "csisolatin2",
    "iso-8859-2",
    "iso-ir-101",
    "iso8859-2",
    "iso88592",
    "iso_8859-2",
    "iso_8859-2:1987",
    "l2",
    "latin2"
], SingleByteDecoder.forCodePoints(iso88592), SingleByteEncoder.forCodePoints(iso88592));
