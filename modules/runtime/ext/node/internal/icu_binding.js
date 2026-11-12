'use strict';

// Node's internalBinding('icu') transcode and icuErrName (src/node_i18n.cc): transcode returns
// the converted Buffer, or the ICU error code when it cannot convert.

const { isUtf8, latin1Slice, ucs2Slice, utf8Slice } = require('internal/buffer_binding');
const { Buffer } = require('buffer');

const U_ILLEGAL_ARGUMENT_ERROR = 1;
const U_INVALID_CHAR_FOUND = 10;
const errorNames = { __proto__: null, [U_ILLEGAL_ARGUMENT_ERROR]: 'U_ILLEGAL_ARGUMENT_ERROR', [U_INVALID_CHAR_FOUND]: 'U_INVALID_CHAR_FOUND' };
// The encodings Node's transcode() supports.
const transcodeEncodings = ['utf8', 'utf16le', 'latin1', 'ascii'];

function icuErrName(code) {
  return errorNames[code] ?? 'U_ZERO_ERROR';
}

function transcode(source, fromEncoding, toEncoding) {
  if (!transcodeEncodings.includes(fromEncoding) || !transcodeEncodings.includes(toEncoding)) {
    return U_ILLEGAL_ARGUMENT_ERROR;
  }
  if (fromEncoding === 'utf8' && toEncoding === 'utf16le' &&
      !isUtf8(source)) {
    return U_INVALID_CHAR_FOUND;
  }
  let text;
  if (fromEncoding === 'ascii' && toEncoding !== 'utf16le') {
    text = '';
    for (let i = 0; i < source.length; i++)
      text += source[i] < 128 ? String.fromCharCode(source[i]) : '�';
  } else if (fromEncoding === 'utf8') {
    text = utf8Slice(source, 0, source.length);
  } else if (fromEncoding === 'utf16le') {
    text = ucs2Slice(source, 0, source.length);
  } else {
    text = latin1Slice(source, 0, source.length);
  }
  if (fromEncoding === 'utf16le') {
    if (toEncoding === 'utf8') {
      if (text.length === 0) return U_INVALID_CHAR_FOUND;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = text.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return U_INVALID_CHAR_FOUND;
        } else if (c >= 0xdc00 && c <= 0xdfff) {
          return U_INVALID_CHAR_FOUND;
        }
      }
    } else {
      // Lone surrogates become U+FFFD, as ICU's UTF-16 converter does.
      text = utf8Slice(Buffer.from(text, 'utf8'), 0);
      if (toEncoding === 'utf16le' && source.length % 2) text += '�';
    }
  }
  if (toEncoding === 'ascii' || toEncoding === 'latin1') {
    const max = toEncoding === 'ascii' ? 127 : 255;
    const out = [];
    for (const char of text) {
      const cp = char.codePointAt(0);
      out.push(cp <= max ? cp : 0x3f);
    }
    return Buffer.from(out);
  }
  return Buffer.from(text, toEncoding);
}

module.exports = { icuErrName, transcode };
