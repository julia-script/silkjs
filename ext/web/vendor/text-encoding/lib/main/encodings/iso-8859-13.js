/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const iso885913 = require("internal/web/vendor/text-encoding/data/iso-8859-13.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("iso-8859-13", [
    "iso-8859-13",
    "iso8859-13",
    "iso885913"
], SingleByteDecoder.forCodePoints(iso885913), SingleByteEncoder.forCodePoints(iso885913));
