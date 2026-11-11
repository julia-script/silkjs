/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const windows1255 = require("internal/web/vendor/text-encoding/data/windows-1255.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("windows-1255", [
    "cp1255",
    "windows-1255",
    "x-cp1255"
], SingleByteDecoder.forCodePoints(windows1255), SingleByteEncoder.forCodePoints(windows1255));
