pragma Singleton
import QtQuick
import Quickshell.Io
import "Config.js" as Config

/* The isolate, once per plugin.
 *
 * A QML singleton lives once per engine, and the shell is one engine —
 * so however many monitors show the bar widget, there is one `yeet run`
 * and every widget is a view of it. That is the same shape two browser
 * tabs have in yeetkit.
 *
 * The transport is the process's own stdio. An isolate only has a tty
 * — the one lane with an input side — when it is given a PTY, and a
 * plain pipe is not one, so the run is wrapped in `script`: the isolate
 * sees a terminal, its output comes back on our stdout, and every byte
 * we write to stdin is a keystroke to it. That is exactly what the
 * yeetkit protocol was designed to survive: frames down inside an OSC
 * sequence escaped to ASCII, messages up as base64url ending in Enter.
 * No port, no socket, nothing another user on the machine can dial.
 *
 * Clients attach and detach; the run starts with the first and stops a
 * few seconds after the last, so disabling the plugin stops the
 * isolate too. A rewritten app.js — the dev loop's rebuild — restarts
 * it, and every attached client reconnects and asks for a fresh tree.
 */
QtObject {
  id: root

  readonly property string appPath: String(Qt.resolvedUrl("../app.js")).replace(/^file:\/\//, "")
  readonly property bool live: process.running
  property int clients: 0

  /** A chunk of the isolate's output, frames and all. */
  signal chunk(string data)

  function attach() {
    clients += 1
    stopTimer.stop()
    if (!process.running) process.running = true
  }

  function detach() {
    clients = Math.max(0, clients - 1)
    if (clients === 0) stopTimer.restart()
  }

  /** Text for the isolate's stdin — already encoded for the uplink. */
  function send(text) {
    if (!process.running) return false
    process.write(text)
    return true
  }

  function restart() {
    if (process.running) process.signal(15)
    else if (clients > 0) process.running = true
  }

  property Process process: Process {
    command: ["script", "-qfec", Config.shellCommand(root.appPath), "/dev/null"]
    stdinEnabled: true
    /* No marker: chunks arrive as the read returns them, and the
     * client's framer finds the frame boundaries. */
    stdout: SplitParser {
      splitMarker: ""
      onRead: function (data) { root.chunk(data) }
    }
    stderr: SplitParser {
      onRead: function (line) { if (line.trim() !== "") console.warn("[" + Config.id + "] " + line) }
    }
    /* The daemon tears the portal down a moment after a run exits, so
     * an immediate respawn is met with "already mounted". */
    onExited: function (code, status) { if (root.clients > 0) root.respawn.restart() }
  }

  property Timer respawn: Timer {
    interval: 1500
    repeat: false
    onTriggered: if (root.clients > 0 && !root.process.running) root.process.running = true
  }

  property Timer stopTimer: Timer {
    interval: 5000
    repeat: false
    onTriggered: if (root.clients === 0) root.process.running = false
  }

  property FileView watcher: FileView {
    path: root.appPath
    watchChanges: true
    onFileChanged: root.restart()
  }
}
