"""Run the production CLI's self-test positive and negative controls in PR Gate."""
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location('production', Path(__file__).with_name('verify-ndk-archive.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ArchiveTests = module.ArchiveTests
