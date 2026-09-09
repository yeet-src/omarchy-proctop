import QtQuick
import "Protocol.js" as Protocol

/* A client's handle on the plugin's one isolate: the same
 * `send`/`message`/`opened`/`closed` contract a socket would offer,
 * over the Isolate singleton's stdio. */
QtObject {
  id: root

  readonly property bool live: Isolate.live

  signal message(string text)
  signal opened()
  signal closed()

  function send(buffer) {
    if (!Isolate.live) return false
    return Isolate.send(Protocol.bytesToString(buffer))
  }

  property Connections link: Connections {
    target: Isolate
    function onChunk(data) { root.message(data) }
    function onLiveChanged() { Isolate.live ? root.opened() : root.closed() }
  }

  Component.onCompleted: Isolate.attach()
  Component.onDestruction: Isolate.detach()
}
