/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const windows1256 = require("internal/web/vendor/text-encoding/data/windows-1256.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("windows-1256", [
    "cp1256",
    "windows-1256",
    "x-cp1256"
], SingleByteDecoder.forCodePoints(windows1256), SingleByteEncoder.forCodePoints(windows1256));
