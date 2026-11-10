/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const windows874 = require("internal/web/vendor/text-encoding/data/windows-874.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("windows-874", [
    "dos-874",
    "iso-8859-11",
    "iso8859-11",
    "iso885911",
    "tis-620",
    "windows-874"
], SingleByteDecoder.forCodePoints(windows874), SingleByteEncoder.forCodePoints(windows874));
