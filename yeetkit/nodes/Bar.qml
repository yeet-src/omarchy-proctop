import QtQuick
import qs.Commons
import qs.Ui

// <bar tooltipText active dimmed heat onClick onWheel>  the widget in
// the bar.
// Its children are strings — the label — and it borrows every bit of
// chrome from the host's own WidgetButton: hover, tooltip, click
// registration, vertical bars.
//
// `heat` is 0..1 and colours the label from the theme — 0 is `muted`,
// 0.5 `accent`, 1 `urgent` — the same scale <text heat> uses. It
// applies to the whole label, because the host draws it as one Text:
// there is no way to colour part of a bar item.
WidgetButton {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)

  bar: client ? client.bar : null

  property real heat: -1

  function mixColor(a, b, t) {
    return Qt.rgba(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t,
                   a.b + (b.b - a.b) * t, a.a + (b.a - a.a) * t)
  }

  readonly property color heatColor: heat < 0.5
    ? mixColor(Color.muted, Color.accent, Math.max(0, heat) * 2)
    : mixColor(Color.accent, Color.urgent, (Math.min(1, heat) - 0.5) * 2)

  foreground: heat >= 0 ? heatColor : (bar ? bar.barForeground : Color.foreground)

  onPressed: function (button) {
    ev("click", { button: button === Qt.LeftButton ? 0 : button === Qt.MiddleButton ? 1 : 2 })
  }
  onWheelMoved: function (delta) { ev("wheel", { delta: delta }) }
}
