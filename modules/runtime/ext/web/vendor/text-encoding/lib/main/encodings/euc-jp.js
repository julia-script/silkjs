/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const { EUCJPDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/EUCJPDecoder");
const { EUCJPEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/EUCJPEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("euc-jp", [
    "cseucpkdfmtjapanese",
    "euc-jp",
    "x-euc-jp"
], EUCJPDecoder, EUCJPEncoder);
