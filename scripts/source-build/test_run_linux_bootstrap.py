import importlib.util
import json
from pathlib import Path
import os
import subprocess
import tempfile
import time
import unittest

SPEC = importlib.util.spec_from_file_location('linux_bootstrap', Path(__file__).with_name('run-linux-bootstrap.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


@unittest.skipIf(os.name == 'nt', 'Linux bootstrap uses POSIX process groups')
class LinuxBootstrapTest(unittest.TestCase):
    def fixture(self, root, body):
        target = root / 'target with spaces'
        (target / 'debootstrap').mkdir(parents=True)
        command = root / 'fake-debootstrap'
        command.write_text('#!' + __import__('sys').executable + '\n' + body)
        command.chmod(0o755)
        return target, str(command)

    def test_host_command_keeps_target_and_metadata_bound(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target, command = self.fixture(root, 'import os,sys,json\nfrom pathlib import Path\nPath(os.environ["DEBOOTSTRAP_DIR"]).joinpath("observed.json").write_text(json.dumps([sys.argv[1:],os.environ["DEBOOTSTRAP_DIR"]]))\n')
            self.assertEqual(MODULE.run(target, command, 5, 0.1), 0)
            args, metadata = json.loads((target / 'debootstrap/observed.json').read_text())
            self.assertEqual(args, ['--second-stage', '--second-stage-target=' + str(target.resolve())])
            self.assertEqual(metadata, str((target / 'debootstrap').resolve()))

    def test_failure_stays_failure_and_reports_inner_log(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target, command = self.fixture(root, 'import os,sys\nfrom pathlib import Path\nPath(os.environ["DEBOOTSTRAP_DIR"]).joinpath("debootstrap.log").write_text("fixture dpkg failure\\n")\nsys.exit(7)\n')
            self.assertEqual(MODULE.run(target, command, 5, 0.1), 7)

    def test_timeout_terminates_a_real_sleeping_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target, command = self.fixture(root, 'import time\ntime.sleep(30)\n')
            with self.assertRaises(subprocess.TimeoutExpired):
                MODULE.run(target, command, 0.15, 0.05)

    def test_timeout_stops_a_descendant_which_ignores_term(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            body = ('import os,signal,time\nfrom pathlib import Path\n'
                    'if os.fork() == 0:\n'
                    ' signal.signal(signal.SIGTERM,signal.SIG_IGN)\n'
                    ' p=Path(os.environ["DEBOOTSTRAP_DIR"])/"heartbeat"\n'
                    ' while True:\n  p.write_text(str(time.monotonic()))\n  time.sleep(0.01)\n'
                    'else:\n time.sleep(30)\n')
            target, command = self.fixture(root, body)
            with self.assertRaises(subprocess.TimeoutExpired):
                MODULE.run(target, command, 2, 0.2)
            heartbeat = target / 'debootstrap/heartbeat'
            self.assertTrue(heartbeat.is_file(), 'controlled child must actually run before timeout')
            before = heartbeat.read_text()
            time.sleep(0.2)
            self.assertEqual(before, heartbeat.read_text())

    def test_cli_cancellation_stops_target_processes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target, command = self.fixture(root, 'import os,time\nfrom pathlib import Path\np=Path(os.environ["DEBOOTSTRAP_DIR"])/"heartbeat"\nwhile True:\n p.write_text(str(time.monotonic()))\n time.sleep(0.01)\n')
            (root / 'debootstrap').symlink_to(command)
            env = {**os.environ, 'PATH': str(root) + os.pathsep + os.environ['PATH']}
            child = subprocess.Popen([__import__('sys').executable, str(Path(__file__).with_name('run-linux-bootstrap.py')), str(target)],
                                     env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                heartbeat = target / 'debootstrap/heartbeat'
                deadline = time.monotonic() + 10
                while not heartbeat.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(heartbeat.exists())
                child.terminate()
                self.assertNotEqual(child.wait(timeout=10), 0)
                before = heartbeat.read_text()
                time.sleep(0.2)
                self.assertEqual(before, heartbeat.read_text())
            finally:
                if child.poll() is None:
                    child.terminate(); child.wait(timeout=10)

    def test_failed_parent_cannot_leave_a_running_descendant(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            body = ('import os,signal,time,sys\nfrom pathlib import Path\n'
                    'p=Path(os.environ["DEBOOTSTRAP_DIR"])/"heartbeat"\n'
                    'if os.fork() == 0:\n'
                    ' signal.signal(signal.SIGTERM,signal.SIG_IGN)\n'
                    ' while True:\n  p.write_text(str(time.monotonic()))\n  time.sleep(0.01)\n'
                    'else:\n'
                    ' deadline=time.monotonic()+3\n'
                    ' while not p.exists() and time.monotonic()<deadline: time.sleep(0.01)\n'
                    ' sys.exit(7)\n')
            target, command = self.fixture(root, body)
            self.assertEqual(MODULE.run(target, command, 5, 0.2), 7)
            heartbeat = target / 'debootstrap/heartbeat'
            self.assertTrue(heartbeat.exists())
            before = heartbeat.read_text()
            time.sleep(0.2)
            self.assertEqual(before, heartbeat.read_text())

    def test_root_and_linked_metadata_are_rejected_before_spawn(self):
        with self.assertRaisesRegex(ValueError, 'dedicated rootfs'):
            MODULE.run('/')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / 'target'; target.mkdir()
            (target / 'debootstrap').symlink_to(root, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'dedicated rootfs'):
                MODULE.run(target)


if __name__ == '__main__':
    unittest.main()
