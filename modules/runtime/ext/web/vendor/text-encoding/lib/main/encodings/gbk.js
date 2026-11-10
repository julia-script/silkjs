/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const { GBDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/GBDecoder");
const { GBKEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/GBEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("gbk", [
    "chinese",
    "csgb2312",
    "csiso58gb231280",
    "gb2312",
    "gb_2312",
    "gb_2312-80",
    "gbk",
    "iso-ir-58",
    "x-gbk"
], GBDecoder, GBKEncoder);
