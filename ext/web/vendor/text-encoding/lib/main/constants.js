/*
 * Copyright (C) 2021 Klaus Reimer <k@ailis.de>
 * See LICENSE.md for licensing information.
 */
/** The default encoding used for encoding and decoding texts. */
const DEFAULT_ENCODING = "utf-8";
/** Value returned by decoders/encoders when finished encoding/decoding. */
const FINISHED = -1;

Object.assign(exports, { DEFAULT_ENCODING, FINISHED });
