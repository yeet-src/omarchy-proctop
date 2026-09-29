.pragma library

/* The wire, as the browser client speaks it — see yeetkit's
 * src/runtime/protocol.js for why it looks this way.
 *
 * Down: frames arrive inside an OSC sequence, JSON escaped to pure
 * ASCII so a PTY cannot rewrite a byte of it. Up: a message goes as
 * base64url text terminated by a newline, in a *binary* WebSocket
 * frame, because the far side is a terminal input decoder and that is
 * the one shape it turns back into a message.
 *
 * QML's JavaScript has typed arrays but no TextEncoder, so UTF-8 is
 * done by hand.
 */

var OSC_OPEN = "\x1b]7880;";
var OSC_CLOSE = "\x07";
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function utf8(text) {
  var bytes = [];
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      var low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

/** A message, encoded for the uplink: an ArrayBuffer for sendBinaryMessage. */
function encodeUplink(message) {
  var bytes = utf8(JSON.stringify(message));
  var out = "";
  var bits = 0;
  var width = 0;
  for (var i = 0; i < bytes.length; i++) {
    bits = (bits << 8) | bytes[i];
    width += 8;
    while (width >= 6) {
      width -= 6;
      out += B64[(bits >> width) & 0x3f];
    }
  }
  if (width > 0) out += B64[(bits << (6 - width)) & 0x3f];
  out += "\n";

  var buffer = new ArrayBuffer(out.length);
  var view = new Uint8Array(buffer);
  for (var j = 0; j < out.length; j++) view[j] = out.charCodeAt(j);
  return buffer;
}

/* A downlink chunk that arrived as bytes. Frames are ASCII by
 * construction, so byte-per-character is the correct decoding; a
 * stray non-ASCII byte outside a frame (an app's console.log on the
 * console lane) only has to survive, not read well. */
function bytesToString(buffer) {
  var view = new Uint8Array(buffer);
  var out = "";
  var STEP = 8192;
  for (var i = 0; i < view.length; i += STEP) {
    out += String.fromCharCode.apply(null, Array.prototype.slice.call(view, i, i + STEP));
  }
  return out;
}

/* The most a single frame may run to. Patches are UI-tree deltas —
 * a few hundred bytes to a few hundred KiB for a full mount — so a
 * body past this is not a patch but a fault or a hostile app, and the
 * framer must not keep buffering it: the isolate's stdout is
 * unbounded and the shell's memory is not. */
var MAX_FRAME = 8 * 1024 * 1024;

/* Frames can be split across messages and several can share one; the
 * framer keeps the tail and hands out whole patches. Returns a
 * function to feed text into.
 *
 * A frame whose body outgrows MAX_FRAME is dropped before it is parsed:
 * its opener is discarded and scanning resumes at the next one, so the
 * rest of the oversized body streams past as noise and `pending` never
 * holds more than MAX_FRAME plus one chunk. */
function framer(onPatch, onError) {
  var pending = "";
  function reject(reason, preview) {
    if (onError) onError(reason instanceof Error ? reason : new Error(reason), preview);
  }
  return function (chunk) {
    pending += chunk;
    for (;;) {
      var start = pending.indexOf(OSC_OPEN);
      if (start < 0) {
        pending = pending.slice(-OSC_OPEN.length);
        return;
      }
      var bodyStart = start + OSC_OPEN.length;
      var end = pending.indexOf(OSC_CLOSE, bodyStart);
      if (end < 0) {
        if (pending.length - bodyStart > MAX_FRAME) {
          reject("frame exceeds " + MAX_FRAME + " bytes", pending.substr(bodyStart, 200));
          pending = pending.slice(bodyStart);
          continue;
        }
        pending = pending.slice(start);
        return;
      }
      var body = pending.slice(bodyStart, end);
      pending = pending.slice(end + OSC_CLOSE.length);
      if (body.length > MAX_FRAME) {
        reject("frame exceeds " + MAX_FRAME + " bytes", body.slice(0, 200));
        continue;
      }
      var patch = null;
      try {
        patch = JSON.parse(body);
      } catch (error) {
        reject(error, body.slice(0, 200));
        continue;
      }
      onPatch(patch);
    }
  };
}
