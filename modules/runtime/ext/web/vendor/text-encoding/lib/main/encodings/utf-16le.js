/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const { UTF16LEDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/UTF16Decoder");
const { UTF16LEEncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/UTF16Encoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("utf-16le", [
    "csunicode",
    "iso-10646-ucs-2",
    "ucs-2",
    "unicode",
    "unicodefeff",
    "utf-16",
    "utf-16le"
], UTF16LEDecoder, UTF16LEEncoder);
