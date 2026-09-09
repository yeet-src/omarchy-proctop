import QtQuick

// <image src size>
Image {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)

  property string src: ""
  property int size: 0

  source: src
  width: size > 0 ? size : implicitWidth
  height: size > 0 ? size : implicitHeight
  fillMode: Image.PreserveAspectFit
  asynchronous: true
}
