"""CPU-only orchestration and source hygiene checks; does not export models."""
import ast
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools/export"
spec = importlib.util.spec_from_file_location("export_models", TOOLS / "export_models.py")
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)

class ExportTools(unittest.TestCase):
    def test_flash_order(self):
        commands = pipeline.commands("flash", Path("scratch"))
        self.assertEqual(len(commands), 3)
        self.assertEqual(commands[0][-2:], ["--precision", "bf16"])
        self.assertTrue(commands[-1][-1].endswith("wavegen_flash_step.onnx"))

    def test_vspec_repairs_in_order(self):
        commands = pipeline.commands("vspec", Path("scratch"))
        self.assertEqual(len(commands), 7)
        self.assertEqual([Path(c[1]).name for c in commands[-4:]], ["promote_opmath.py", "promote_activations.py", "fuse_linear_bias.py", "use_attention_operator.py"])
        self.assertIn("--dropout", commands[3])
        self.assertTrue(commands[-1][-1].endswith("_opmath_dropout_activations_gemm.onnx"))

    def test_reuse_licensed_fixture_opt_in(self):
        self.assertNotIn("--audio-fixture", pipeline.commands("reuse", Path("scratch"))[0])
        self.assertIn("--audio-fixture", pipeline.commands("reuse", Path("scratch"), True)[0])

    def test_sources_parse_and_no_private_defaults(self):
        for path in TOOLS.rglob("*.py"):
            source = path.read_text(encoding="utf-8")
            ast.parse(source, filename=str(path))
            self.assertNotIn("basic_ref_en.wav", source)
            self.assertNotIn("work/studio_validation", source)
            self.assertNotIn("noisy_audio/mic_test2.wav", source)

    def test_dry_run_without_gpu_imports(self):
        result = subprocess.run([sys.executable, str(TOOLS / "export_models.py"), "--dry-run"], capture_output=True, text=True, check=True)
        self.assertIn("use_attention_operator.py", result.stdout)
        self.assertIn("export_reuse.py", result.stdout)

if __name__ == "__main__":
    unittest.main()
