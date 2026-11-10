/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const iso885915 = require("internal/web/vendor/text-encoding/data/iso-8859-15.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("iso-8859-15", [
    "csisolatin9",
    "iso-8859-15",
    "iso8859-15",
    "iso885915",
    "iso_8859-15",
    "l9"
], SingleByteDecoder.forCodePoints(iso885915), SingleByteEncoder.forCodePoints(iso885915));
