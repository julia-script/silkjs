/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
const { EUCKRDecoder } = require("internal/web/vendor/text-encoding/lib/main/decoders/EUCKRDecoder");
const { EUCKREncoder } = require("internal/web/vendor/text-encoding/lib/main/encoders/EUCKREncoder");
const { registerEncoding } = require("internal/web/vendor/text-encoding/lib/main/Encoding");
registerEncoding("euc-kr", [
    "cseuckr",
    "csksc56011987",
    "euc-kr",
    "iso-ir-149",
    "korean",
    "ks_c_5601-1987",
    "ks_c_5601-1989",
    "ksc5601",
    "ksc_5601",
    "windows-949"
], EUCKRDecoder, EUCKREncoder);
