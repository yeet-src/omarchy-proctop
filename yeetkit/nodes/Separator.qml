import QtQuick
import qs.Ui

// <separator>  a hairline between sections
PanelSeparator {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)

  readonly property bool inRow: parent ? parent.axis === "x" : false
  anchors.left: parent && !inRow ? parent.left : undefined
  anchors.right: parent && !inRow ? parent.right : undefined
}
