/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const iso88597 = require("internal/web/vendor/text-encoding/data/iso-8859-7.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("iso-8859-7", [
    "csisolatingreek",
    "ecma-118",
    "elot_928",
    "greek",
    "greek8",
    "iso-8859-7",
    "iso-ir-126",
    "iso8859-7",
    "iso88597",
    "iso_8859-7",
    "iso_8859-7:1987",
    "sun_eu_greek"
], SingleByteDecoder.forCodePoints(iso88597), SingleByteEncoder.forCodePoints(iso88597));
