import QtQuick
import qs.Ui

// <input value placeholder password onInput onSubmit>
// Controlled: `value` is what the app says, `input` is what was typed.
TextField {
  id: root
  property var client: null
  property int nodeId: 0
  property Item slot: null
  signal ev(string type, var payload)

  property string value: ""
  property string placeholder: ""

  readonly property bool inRow: parent ? parent.axis === "x" : false
  anchors.left: parent && !inRow ? parent.left : undefined
  anchors.right: parent && !inRow ? parent.right : undefined
  placeholderText: placeholder

  onValueChanged: if (text !== value) text = value
  onTextEdited: ev("input", { value: text })
  onAccepted: ev("submit", { value: text })
  /* A panel's key catcher takes j/k and Escape first; while this has
   * focus it has to stand aside. */
  onActiveFocusChanged: if (client) client.inputFocus = activeFocus
}
