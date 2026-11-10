/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const { UTF16BEDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/UTF16Decoder");
const { UTF16BEEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/UTF16Encoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("utf-16be", [
    "unicodefffe",
    "utf-16be"
], UTF16BEDecoder, UTF16BEEncoder);
