/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const { UTF8Decoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/UTF8Decoder");
const { UTF8Encoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/UTF8Encoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("utf-8", [
    "unicode-1-1-utf-8",
    "unicode11utf8",
    "unicode20utf8",
    "utf-8",
    "utf8",
    "x-unicode20utf8"
], UTF8Decoder, UTF8Encoder);
