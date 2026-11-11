/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const iso88595 = require("internal/web/vendor/text-encoding/data/iso-8859-5.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("iso-8859-5", [
    "csisolatincyrillic",
    "cyrillic",
    "iso-8859-5",
    "iso-ir-144",
    "iso8859-5",
    "iso88595",
    "iso_8859-5",
    "iso_8859-5:1988"
], SingleByteDecoder.forCodePoints(iso88595), SingleByteEncoder.forCodePoints(iso88595));
