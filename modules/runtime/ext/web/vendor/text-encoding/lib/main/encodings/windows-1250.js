/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const windows1250 = require("internal/web/vendor/text-encoding/data/windows-1250.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("windows-1250", [
    "cp1250",
    "windows-1250",
    "x-cp1250"
], SingleByteDecoder.forCodePoints(windows1250), SingleByteEncoder.forCodePoints(windows1250));
