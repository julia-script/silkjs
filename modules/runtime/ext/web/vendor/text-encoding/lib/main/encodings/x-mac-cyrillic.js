/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const xMacCyrillic = require("internal/web/vendor/text-encoding/data/x-mac-cyrillic.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("x-mac-cyrillic", [
    "x-mac-cyrillic",
    "x-mac-ukrainian"
], SingleByteDecoder.forCodePoints(xMacCyrillic), SingleByteEncoder.forCodePoints(xMacCyrillic));
