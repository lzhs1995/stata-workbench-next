# DOCX namespace regression fixture

`python-docx-document.xml` was generated with python-docx 1.2.0 using
`Document()`, a paragraph, a two-by-two table, and a Workbench image-marker
paragraph, then extracted from `word/document.xml` without XML rewriting.
SHA-256: `295444694683be40ddf99a1bc3072155a5fcd798e5ef430057bf63fa309eb046`.

The default template declares `w14` and `wp14` only for the root
`mc:Ignorable` value. Removing those declarations reproduces the native Word
unreadable-content prompt. Tests use the frozen XML and only the Python standard
library; they do not require python-docx to be installed.
