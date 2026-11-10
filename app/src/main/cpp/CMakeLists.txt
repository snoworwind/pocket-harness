cmake_minimum_required(VERSION 3.22.1)
project(pocketharness_terminal C)

# libvterm (MIT) —— 原样 vendored，见 libvterm/README.pocketharness.md。
set(LIBVTERM_DIR ${CMAKE_CURRENT_SOURCE_DIR}/libvterm)
add_library(vterm STATIC
  ${LIBVTERM_DIR}/src/vterm.c
  ${LIBVTERM_DIR}/src/parser.c
  ${LIBVTERM_DIR}/src/state.c
  ${LIBVTERM_DIR}/src/screen.c
  ${LIBVTERM_DIR}/src/pen.c
  ${LIBVTERM_DIR}/src/keyboard.c
  ${LIBVTERM_DIR}/src/mouse.c
  ${LIBVTERM_DIR}/src/unicode.c
  ${LIBVTERM_DIR}/src/encoding.c
)
target_include_directories(vterm PUBLIC ${LIBVTERM_DIR}/include)
target_include_directories(vterm PRIVATE ${LIBVTERM_DIR}/src)
target_compile_options(vterm PRIVATE -std=c99 -Wall -Wextra -Wno-unused-parameter)

add_library(pocketharness_terminal SHARED terminal_jni.c)
target_link_libraries(pocketharness_terminal PRIVATE vterm)
target_include_directories(pocketharness_terminal PRIVATE ${LIBVTERM_DIR}/include)
target_compile_options(pocketharness_terminal PRIVATE -std=c99 -Wall -Wextra)
