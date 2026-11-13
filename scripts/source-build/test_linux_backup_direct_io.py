"""Exercise the production JNI direct reader on Linux before building Android APKs."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(sys.platform == 'linux', 'O_DIRECT integration requires Linux')
class BackupDirectIoTest(unittest.TestCase):
    def test_actual_jni_reads_aligned_blocks_and_rejects_unsupported_descriptors(self):
        # Linux CI supplies a JDK and C compiler; missing tools must fail, not silently skip.
        java = shutil.which('java')
        javac = shutil.which('javac')
        cc = shutil.which('cc')
        self.assertTrue(java and javac and cc, 'Linux direct IO regression needs JDK and cc')
        jdk = Path(javac).resolve().parents[1]
        cpp = ROOT / 'app/src/main/cpp'
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            library = work / 'libbackup-test.so'
            sources = [cpp / 'terminal_jni.c'] + sorted((cpp / 'libvterm/src').glob('*.c'))
            build = subprocess.run([cc, '-shared', '-fPIC', '-std=c99', '-O2', '-Wall', '-Wextra',
                                    '-I' + str(jdk / 'include'), '-I' + str(jdk / 'include/linux'),
                                    '-I' + str(cpp / 'libvterm/include'), '-I' + str(cpp / 'libvterm/src'),
                                    *map(str, sources), '-lm', '-o', str(library)],
                                   capture_output=True, text=True, timeout=60)
            self.assertEqual(build.returncode, 0, build.stderr)
            source = work / 'TerminalNative.java'
            source.write_text(r'''
package com.snoworwind.pocketharness;
import java.io.*;
import java.lang.reflect.Field;
import java.nio.file.*;
import java.util.Arrays;
public class TerminalNative {
  private native int nativeReadDirect(int fd, long offset, byte[] output) throws IOException;
  private static int fd(RandomAccessFile file) throws Exception {
    Field field = FileDescriptor.class.getDeclaredField("fd"); field.setAccessible(true);
    return field.getInt(file.getFD());
  }
  private static void check(boolean value) { if (!value) throw new AssertionError(); }
  public static void main(String[] args) throws Exception {
    System.load(args[0]);
    TerminalNative reader = new TerminalNative();
    byte[] data = new byte[1024 * 1024 + 512];
    for (int i = 0; i < data.length; ++i) data[i] = (byte)(i % 127);
    Path file = Path.of(args[1]); Files.write(file, data);
    try (RandomAccessFile input = new RandomAccessFile(file.toFile(), "rw")) {
      input.getFD().sync(); int descriptor = fd(input); byte[] block = new byte[1024 * 1024];
      check(reader.nativeReadDirect(descriptor, 0, block) == block.length);
      check(Arrays.equals(block, Arrays.copyOf(data, block.length)));
      check(reader.nativeReadDirect(descriptor, block.length, block) == 512);
      check(Arrays.equals(Arrays.copyOf(block, 512), Arrays.copyOfRange(data, 1024 * 1024, data.length)));
      try { reader.nativeReadDirect(descriptor, 1, block); throw new AssertionError(); } catch (IOException expected) {}
      try { reader.nativeReadDirect(descriptor, 0, new byte[512]); throw new AssertionError(); } catch (IOException expected) {}
      // A truncated final block is observable rather than padded with cached data.
      input.setLength(1024 * 1024); input.getFD().sync();
      check(reader.nativeReadDirect(descriptor, 1024 * 1024, block) == 0);
      input.seek(0); input.write(new byte[512]); input.getFD().sync();
      check(reader.nativeReadDirect(descriptor, 0, block) == block.length);
      check(!Arrays.equals(block, Arrays.copyOf(data, block.length)));
    }
    try (RandomAccessFile unsupported = new RandomAccessFile("/dev/null", "r")) {
      try { reader.nativeReadDirect(fd(unsupported), 0, new byte[1024 * 1024]); throw new AssertionError(); }
      catch (IOException expected) {}
    }
  }
}
''')
            compile_java = subprocess.run([javac, '-d', str(work), str(source)], capture_output=True, text=True, timeout=30)
            self.assertEqual(compile_java.returncode, 0, compile_java.stderr)
            result = subprocess.run([java, '--add-opens', 'java.base/java.io=ALL-UNNAMED', '-cp', str(work),
                                     'com.snoworwind.pocketharness.TerminalNative', str(library), str(work / 'backup.tar')],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
