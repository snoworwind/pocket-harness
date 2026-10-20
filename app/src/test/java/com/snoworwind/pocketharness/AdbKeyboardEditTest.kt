package com.snoworwind.pocketharness

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AdbKeyboardEditTest {
  @Test
  fun commitIsAttemptedWhenBatchEditingIsUnsupported() {
    val port = RecordingPort(batchStarted = false)

    val result = AdbKeyboardEdits.commit(port, "中文🙂")

    assertEquals(AdbKeyboardEditStatus.EDIT_DISPATCHED, result)
    assertEquals("中文🙂", port.committedText)
    assertEquals(0, port.endBatchCalls)
  }

  @Test
  fun falseCommitAndFailedBatchClosureRemainUnconfirmed() {
    val rejectedEdit = RecordingPort(batchStarted = true, commitAccepted = false)
    assertEquals(AdbKeyboardEditStatus.EDIT_UNCONFIRMED, AdbKeyboardEdits.commit(rejectedEdit, "x"))
    assertEquals(1, rejectedEdit.endBatchCalls)

    val unclosedBatch = RecordingPort(batchStarted = true, batchEndAccepted = false)
    assertEquals(AdbKeyboardEditStatus.EDIT_UNCONFIRMED, AdbKeyboardEdits.commit(unclosedBatch, "x"))
  }

  @Test
  fun clearSelectsTheWholeFieldAndReplacesSelection() {
    val port = RecordingPort(fullLength = 37, batchStarted = true)

    val result = AdbKeyboardEdits.clear(port)

    assertEquals(AdbKeyboardEditStatus.EDIT_DISPATCHED, result)
    assertEquals(0 to 37, port.selection)
    assertEquals("", port.committedText)
    assertEquals(1, port.endBatchCalls)
  }

  @Test
  fun missingOrPartialTextSnapshotDoesNotAttemptToClear() {
    val port = RecordingPort(fullLength = null)

    val result = AdbKeyboardEdits.clear(port)

    assertEquals(AdbKeyboardEditStatus.EDIT_UNCONFIRMED, result)
    assertNull(port.selection)
    assertNull(port.committedText)
  }

  @Test
  fun onlyACompleteBoundedEditorSnapshotCanProvideClearLength() {
    assertEquals(9, completeEditorTextLength(-1, 0, 9))
    assertNull(completeEditorTextLength(0, 0, 9))
    assertNull(completeEditorTextLength(-1, 2, 9))
    assertNull(completeEditorTextLength(-1, 0, null))
    assertNull(completeEditorTextLength(-1, 0, 16_385))
  }

  @Test
  fun failedSelectionDoesNotCommitAndOversizedSnapshotIsRejected() {
    val failedSelection = RecordingPort(fullLength = 8, selectionAccepted = false)
    assertEquals(AdbKeyboardEditStatus.EDIT_UNCONFIRMED, AdbKeyboardEdits.clear(failedSelection))
    assertNull(failedSelection.committedText)

    val oversized = RecordingPort(fullLength = 16_385)
    assertEquals(AdbKeyboardEditStatus.EDIT_UNCONFIRMED, AdbKeyboardEdits.clear(oversized))
    assertNull(oversized.selection)
  }

  @Test
  fun runtimeEditFailureIsUnconfirmedAndBatchStillCloses() {
    val port = RecordingPort(batchStarted = true, throwOnCommit = true)

    val result = AdbKeyboardEdits.commit(port, "x")

    assertEquals(AdbKeyboardEditStatus.EDIT_UNCONFIRMED, result)
    assertEquals(1, port.endBatchCalls)
  }

  private class RecordingPort(
    private val batchStarted: Boolean = false,
    private val fullLength: Int? = 5,
    private val selectionAccepted: Boolean = true,
    private val commitAccepted: Boolean = true,
    private val batchEndAccepted: Boolean = true,
    private val throwOnCommit: Boolean = false,
  ) : AdbKeyboardEditPort {
    var selection: Pair<Int, Int>? = null
      private set
    var committedText: String? = null
      private set
    var endBatchCalls: Int = 0
      private set

    override fun beginBatchEdit(): Boolean = batchStarted
    override fun fullTextLength(): Int? = fullLength
    override fun setSelection(start: Int, end: Int): Boolean {
      selection = start to end
      return selectionAccepted
    }
    override fun commitText(text: String): Boolean {
      if (throwOnCommit) throw IllegalStateException("connection lost")
      committedText = text
      return commitAccepted
    }
    override fun endBatchEdit(): Boolean {
      endBatchCalls++
      return batchEndAccepted
    }
  }
}
