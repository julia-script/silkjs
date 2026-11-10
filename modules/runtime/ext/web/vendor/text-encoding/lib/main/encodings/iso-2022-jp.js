/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const { ISO2022JPDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/ISO2022JPDecoder");
const { ISO2022JPEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/ISO2022JPEncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("iso-2022-jp", [
    "csiso2022jp",
    "iso-2022-jp"
], ISO2022JPDecoder, ISO2022JPEncoder);
