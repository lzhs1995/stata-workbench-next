"""Exercise namespace *values and scope*, not only XML well-formedness."""
import base64
import io
import os
from pathlib import Path
import runpy
import tempfile
import unittest
import zipfile
from xml.etree import ElementTree as ET


HERE = Path(__file__).resolve().parent
HELPER = runpy.run_path(os.environ.get("DOCX_TEST_HELPER", str(HERE / "docx_image_inject.py")))
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
W = HELPER["NS"]["w"]
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")


def references(xml):
    """Resolve each compatibility token in its actual lexical scope."""
    stack, pending, found = [], {}, []
    for event, node in ET.iterparse(io.BytesIO(xml), events=("start-ns", "start", "end")):
        if event == "start-ns":
            pending[node[0]] = node[1]
        elif event == "start":
            scope = dict(stack[-1]) if stack else {}
            scope.update(pending)
            pending.clear()
            stack.append(scope)
            for key, value in node.attrib.items():
                if key in {f"{{{MC}}}{name}" for name in (
                    "Ignorable", "MustUnderstand", "ProcessContent", "PreserveElements", "PreserveAttributes"
                )} or (node.tag == f"{{{MC}}}Choice" and key == "Requires"):
                    for token in value.split():
                        prefix = token.split(":", 1)[0]
                        if prefix not in scope:
                            raise AssertionError(f"Unbound {prefix} in {key}={value!r}")
                        found.append((node.tag, key, token, scope[prefix]))
        else:
            stack.pop()
    return found


class NamespaceTests(unittest.TestCase):
    def inject(self, xml):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "figure.png").write_bytes(PNG)
            path = root / "fixture.docx"
            with zipfile.ZipFile(path, "w") as package:
                package.writestr("word/document.xml", xml)
                package.writestr("word/_rels/document.xml.rels", '<Relationships xmlns="' + HELPER["NS"]["pr"] + '"/>')
                package.writestr("[Content_Types].xml", '<Types xmlns="' + HELPER["NS"]["ct"] + '"/>')
                package.writestr("word/untouched.xml", b"<!--must remain byte-identical-->")
            self.assertEqual(HELPER["inject"](path)["injected"], 1)
            before = path.read_bytes()
            self.assertTrue(HELPER["inject"](path)["unchanged"])
            self.assertEqual(path.read_bytes(), before)
            with zipfile.ZipFile(path) as package:
                self.assertEqual(package.read("word/media/imageCodex1.png"), PNG)
                self.assertEqual(package.read("word/untouched.xml"), b"<!--must remain byte-identical-->")
                return package.read("word/document.xml")

    def test_real_python_docx_ignorable_and_table(self):
        original = (HERE / "fixtures/python-docx-document.xml").read_bytes()
        expected = references(original)
        self.assertEqual({item[2] for item in expected}, {"w14", "wp14"})
        result = self.inject(original)
        self.assertEqual(references(result), expected)
        before_table = ET.fromstring(original).find(f".//{{{W}}}tbl")
        after_table = ET.fromstring(result).find(f".//{{{W}}}tbl")
        self.assertEqual(ET.tostring(before_table), ET.tostring(after_table))
        self.assertEqual(len(ET.fromstring(result).findall(f".//{{{W}}}drawing")), 1)

    def test_nested_rebinding_and_qname_values(self):
        marker = "__CODEX_DOCX_IMAGE_V1__|path=figure.png|width=4in|height=3in|__END_CODEX_DOCX_IMAGE_V1__"
        original = f'''<d:document xmlns:d="{W}" xmlns:mc="{MC}"
            xmlns:w="urn:outer" mc:Ignorable="w" mc:PreserveAttributes="w:flag">
            <d:body><!--retained-comment--><?fixture retained?>
            <mc:AlternateContent><mc:Choice xmlns:w="urn:inner" Requires="w"
              mc:ProcessContent="w:container" mc:PreserveElements="w:*">
              <w:container><d:p><d:r><d:t>{marker}</d:t></d:r></d:p></w:container>
            </mc:Choice><mc:Fallback><d:p/></mc:Fallback></mc:AlternateContent>
            <w:tail/></d:body></d:document>'''.encode()
        result = self.inject(original)
        self.assertEqual(references(result), references(original))
        tree = ET.fromstring(result)
        self.assertIsNotNone(tree.find(".//{urn:inner}container"))
        self.assertIsNotNone(tree.find(".//{urn:outer}tail"))
        self.assertEqual(len(tree.findall(f".//{{{W}}}drawing")), 1)
        self.assertIn(b"<!--retained-comment-->", result)
        self.assertIn(b"<?fixture retained?>", result)


if __name__ == "__main__":
    unittest.main()
