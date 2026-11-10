/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const { Big5Decoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/Big5Decoder");
const { Big5Encoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/Big5Encoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("big5", [
    "big5",
    "big5-hkscs",
    "cn-big5",
    "csbig5",
    "x-x-big5"
], Big5Decoder, Big5Encoder);
