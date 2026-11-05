/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const koi8u = require("internal/web/vendor/text-encoding/data/koi8-u.cp");
const { SingleByteDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/SingleByteDecoder");
const { SingleByteEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/SingleByteEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("koi8-u", [
    "koi8-ru",
    "koi8-u"
], SingleByteDecoder.forCodePoints(koi8u), SingleByteEncoder.forCodePoints(koi8u));
