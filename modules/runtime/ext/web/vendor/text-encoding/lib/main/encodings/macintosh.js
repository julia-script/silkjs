/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const macintosh = require("internal/web/vendor/text-encoding/data/macintosh.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("macintosh", [
    "csmacintosh",
    "mac",
    "macintosh",
    "x-mac-roman"
], SingleByteDecoder.forCodePoints(macintosh), SingleByteEncoder.forCodePoints(macintosh));
