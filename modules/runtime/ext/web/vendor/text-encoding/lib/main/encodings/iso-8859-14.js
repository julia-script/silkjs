/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const iso885914 = require("internal/web/vendor/text-encoding/data/iso-8859-14.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("iso-8859-14", [
    "iso-8859-14",
    "iso8859-14",
    "iso885914"
], SingleByteDecoder.forCodePoints(iso885914), SingleByteEncoder.forCodePoints(iso885914));
