/*
 * Pocket Harness native terminal core: libvterm (MIT) + a thin JNI surface.
 *
 * 设计约束：
 *  - 只用固定布局的字节缓冲向 Kotlin 交付屏幕（每 cell 16 字节），避免逐 cell JNI 调用；
 *  - 所有 vterm 调用都在调用方线程（Kotlin 主线程）同步执行；输入/尺寸/拷贝不做跨线程状态；
 *  - 颜色统一转 RGB；DEFAULT 用 0xFFFFFFFF 作为哨兵，由 Kotlin 侧映射主题色。
 * 详细方案见 docs/AGENTS/NATIVE-TERMINAL-2026-11-10.md。
 */
#include <jni.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <vterm.h>

/** 每个 cell 的固定字节数：chars(4) + fg(4) + bg(4) + attrs(1) + width(1) + pad(2)。 */
#define DSH_CELL_BYTES 16

typedef struct {
  VTerm *vt;
  VTermScreen *screen;
  int rows;
  int cols;
  int cursor_row;
  int cursor_col;
  int cursor_visible;
} DshTerminal;

static int dsh_move_cursor(VTermPos pos, VTermPos old_pos, int visible, void *user) {
  (void)old_pos;
  DshTerminal *term = (DshTerminal *)user;
  term->cursor_row = pos.row;
  term->cursor_col = pos.col;
  term->cursor_visible = visible;
  return 0;
}

static uint32_t dsh_color_rgb(VTermScreen *screen, VTermColor *color, int background) {
  /* 默认色必须在转换前判定：libvterm 的 type 是位标志，不是互斥枚举。 */
  if (background ? VTERM_COLOR_IS_DEFAULT_BG(color) : VTERM_COLOR_IS_DEFAULT_FG(color)) {
    return 0xFFFFFFFFu;
  }
  vterm_screen_convert_color_to_rgb(screen, color);
  if (VTERM_COLOR_IS_RGB(color)) {
    return ((uint32_t)color->rgb.red << 16) | ((uint32_t)color->rgb.green << 8) | (uint32_t)color->rgb.blue;
  }
  return 0xFFFFFFFFu;
}

static void dsh_write_cell(unsigned char *out, const VTermScreenCell *cell, uint32_t fg, uint32_t bg) {
  uint32_t chars = cell->chars[0];
  unsigned char attrs = 0;
  if (cell->attrs.bold) attrs |= 1u;
  if (cell->attrs.underline) attrs |= 2u;
  if (cell->attrs.italic) attrs |= 4u;
  if (cell->attrs.reverse) attrs |= 8u;
  if (cell->attrs.blink) attrs |= 16u;
  if (cell->attrs.strike) attrs |= 32u;
  memcpy(out + 0, &chars, 4);
  memcpy(out + 4, &fg, 4);
  memcpy(out + 8, &bg, 4);
  out[12] = attrs;
  out[13] = (unsigned char)(cell->width > 0 ? cell->width : 1);
  out[14] = 0;
  out[15] = 0;
}

static DshTerminal *dsh_from(jlong handle) { return (DshTerminal *)(intptr_t)handle; }

JNIEXPORT jlong JNICALL
Java_com_snoworwind_pocketharness_TerminalNative_nativeCreate(JNIEnv *env, jobject self, jint cols, jint rows) {
  (void)env;
  (void)self;
  if (cols < 2 || rows < 1) return 0;
  DshTerminal *term = (DshTerminal *)calloc(1, sizeof(DshTerminal));
  if (term == NULL) return 0;
  term->vt = vterm_new(rows, cols);
  if (term->vt == NULL) {
    free(term);
    return 0;
  }
  term->rows = rows;
  term->cols = cols;
  vterm_set_utf8(term->vt, 1);
  term->screen = vterm_obtain_screen(term->vt);
  static VTermScreenCallbacks callbacks = { .movecursor = dsh_move_cursor };
  if (term->screen == NULL) {
    vterm_free(term->vt);
    free(term);
    return 0;
  }
  vterm_screen_set_callbacks(term->screen, &callbacks, term);
  vterm_screen_enable_altscreen(term->screen, 1);
  vterm_screen_reset(term->screen, 1);
  vterm_screen_flush_damage(term->screen);
  return (jlong)(intptr_t)term;
}

JNIEXPORT void JNICALL
Java_com_snoworwind_pocketharness_TerminalNative_nativeDestroy(JNIEnv *env, jobject self, jlong handle) {
  (void)env;
  (void)self;
  DshTerminal *term = dsh_from(handle);
  if (term == NULL) return;
  if (term->vt != NULL) vterm_free(term->vt);
  free(term);
}

JNIEXPORT void JNICALL
Java_com_snoworwind_pocketharness_TerminalNative_nativeInput(JNIEnv *env, jobject self, jlong handle,
                                                            jbyteArray data, jint length) {
  (void)self;
  DshTerminal *term = dsh_from(handle);
  if (term == NULL || data == NULL || length <= 0) return;
  jsize available = (*env)->GetArrayLength(env, data);
  if (length > available) length = available;
  jbyte *bytes = (*env)->GetByteArrayElements(env, data, NULL);
  if (bytes == NULL) return;
  vterm_input_write(term->vt, (const char *)bytes, (size_t)length);
  (*env)->ReleaseByteArrayElements(env, data, bytes, JNI_ABORT);
  vterm_screen_flush_damage(term->screen);
}

JNIEXPORT void JNICALL
Java_com_snoworwind_pocketharness_TerminalNative_nativeResize(JNIEnv *env, jobject self, jlong handle,
                                                             jint cols, jint rows) {
  (void)env;
  (void)self;
  DshTerminal *term = dsh_from(handle);
  if (term == NULL || cols < 2 || rows < 1) return;
  vterm_set_size(term->vt, rows, cols);
  term->rows = rows;
  term->cols = cols;
  vterm_screen_flush_damage(term->screen);
}

/** 拷贝整屏到 direct ByteBuffer；返回 rows*cols，容量不足或句柄无效返回 -1。 */
JNIEXPORT jint JNICALL
Java_com_snoworwind_pocketharness_TerminalNative_nativeCopyScreen(JNIEnv *env, jobject self, jlong handle,
                                                                 jobject buffer) {
  (void)self;
  DshTerminal *term = dsh_from(handle);
  if (term == NULL || buffer == NULL) return -1;
  jlong capacity = (*env)->GetDirectBufferCapacity(env, buffer);
  unsigned char *out = (unsigned char *)(*env)->GetDirectBufferAddress(env, buffer);
  if (out == NULL) return -1;
  int cells = term->rows * term->cols;
  if (capacity < (jlong)cells * DSH_CELL_BYTES) return -1;
  for (int row = 0; row < term->rows; row++) {
    for (int col = 0; col < term->cols; col++) {
      VTermPos pos;
      pos.row = row;
      pos.col = col;
      VTermScreenCell cell;
      memset(&cell, 0, sizeof(cell));
      vterm_screen_get_cell(term->screen, pos, &cell);
      uint32_t fg = dsh_color_rgb(term->screen, &cell.fg, 0);
      uint32_t bg = dsh_color_rgb(term->screen, &cell.bg, 1);
      dsh_write_cell(out + ((size_t)row * term->cols + col) * DSH_CELL_BYTES, &cell, fg, bg);
    }
  }
  return cells;
}

/** 光标：bit0 可见，bit1..15 列，bit16..31 行。 */
JNIEXPORT jint JNICALL
Java_com_snoworwind_pocketharness_TerminalNative_nativeCursor(JNIEnv *env, jobject self, jlong handle) {
  (void)env;
  (void)self;
  DshTerminal *term = dsh_from(handle);
  if (term == NULL) return 0;
  return (term->cursor_visible ? 1 : 0) | ((term->cursor_col & 0x7FFF) << 1) | ((term->cursor_row & 0xFFFF) << 16);
}

JNIEXPORT jint JNICALL
Java_com_snoworwind_pocketharness_TerminalNative_nativeCellBytes(JNIEnv *env, jobject self) {
  (void)env;
  (void)self;
  return DSH_CELL_BYTES;
}
