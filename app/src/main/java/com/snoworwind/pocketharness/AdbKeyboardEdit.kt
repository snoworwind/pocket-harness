package com.snoworwind.pocketharness

/**
 * A result from the IME edit call. DISPATCHED means InputConnection accepted the
 * request; it does not prove the editor's final text. Callers must verify that
 * separately when they need to report a completed text change.
 */
internal enum class AdbKeyboardEditStatus(val resultCode: Int) {
  EDIT_DISPATCHED(1),
  IME_NOT_READY(2),
  SOURCE_REJECTED(3),
  BAD_REQUEST(4),
  NO_INPUT_CONNECTION(5),
  EDIT_UNCONFIRMED(6),
}

internal const val ADB_KEYBOARD_MAX_CLEAR_TEXT_CHARS = 16_384

/** The extracted snapshot must cover the entire field before it can bound a clear selection. */
internal fun completeEditorTextLength(partialStartOffset: Int, startOffset: Int, textLength: Int?): Int? {
  if (partialStartOffset != -1 || startOffset != 0) return null
  val length = textLength ?: return null
  if (length < 0 || length > ADB_KEYBOARD_MAX_CLEAR_TEXT_CHARS) return null
  return length
}

/** The small InputConnection surface used by the edit dispatcher and its tests. */
internal interface AdbKeyboardEditPort {
  fun beginBatchEdit(): Boolean
  fun fullTextLength(): Int?
  fun setSelection(start: Int, end: Int): Boolean
  fun commitText(text: String): Boolean
  fun endBatchEdit(): Boolean
}

/** Keeps batch editing optional while preserving the real result of each edit call. */
internal object AdbKeyboardEdits {
  fun commit(port: AdbKeyboardEditPort, text: String): AdbKeyboardEditStatus =
    dispatch(port) { port.commitText(text) }

  /**
   * Select the complete editor contents and replace that selection with empty text.
   * A missing or partial text snapshot is not evidence that the whole field was
   * selected, so in that case the operation is left unconfirmed and no edit follows.
   */
  fun clear(port: AdbKeyboardEditPort): AdbKeyboardEditStatus = dispatch(port) {
    val length = port.fullTextLength()?.takeIf { it in 0..ADB_KEYBOARD_MAX_CLEAR_TEXT_CHARS }
      ?: return@dispatch false
    port.setSelection(0, length) && port.commitText("")
  }

  private fun dispatch(port: AdbKeyboardEditPort, edit: () -> Boolean): AdbKeyboardEditStatus {
    val batched = try {
      port.beginBatchEdit()
    } catch (_: RuntimeException) {
      return AdbKeyboardEditStatus.EDIT_UNCONFIRMED
    }

    var accepted = try {
      edit()
    } catch (_: RuntimeException) {
      false
    }

    if (batched) {
      val batchEnded = try {
        port.endBatchEdit()
      } catch (_: RuntimeException) {
        false
      }
      if (!batchEnded) accepted = false
    }

    return if (accepted) AdbKeyboardEditStatus.EDIT_DISPATCHED
    else AdbKeyboardEditStatus.EDIT_UNCONFIRMED
  }
}
