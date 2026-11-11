/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const koi8r = require("internal/web/vendor/text-encoding/data/koi8-r.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("koi8-r", [
    "cskoi8r",
    "koi",
    "koi8",
    "koi8-r",
    "koi8_r"
], SingleByteDecoder.forCodePoints(koi8r), SingleByteEncoder.forCodePoints(koi8r));
