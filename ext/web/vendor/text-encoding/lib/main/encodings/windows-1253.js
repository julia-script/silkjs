/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const windows1253 = require("internal/web/vendor/text-encoding/data/windows-1253.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("windows-1253", [
    "cp1253",
    "windows-1253",
    "x-cp1253"
], SingleByteDecoder.forCodePoints(windows1253), SingleByteEncoder.forCodePoints(windows1253));
