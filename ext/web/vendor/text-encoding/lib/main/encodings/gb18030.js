/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const { GBDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/GBDecoder");
const { GB18030Encoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/GBEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("gb18030", [
    "gb18030"
], GBDecoder, GB18030Encoder);
