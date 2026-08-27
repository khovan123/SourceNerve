from pathlib import Path

path = Path("desktop/src/renderer/components/organisms/AppSidebar.tsx")
text = path.read_text()

old_import = "import {\n  Blocks,"
new_import = "import {\n  Activity,\n  Blocks,"
if text.count(old_import) != 1:
    raise SystemExit(f"expected one sidebar icon import point, found {text.count(old_import)}")
text = text.replace(old_import, new_import, 1)

old_icon = "  plugins: Puzzle,\n  tasks: ListTodo,"
new_icon = "  plugins: Puzzle,\n  harness: Activity,\n  tasks: ListTodo,"
if text.count(old_icon) != 1:
    raise SystemExit(f"expected one sidebar Harness icon point, found {text.count(old_icon)}")
text = text.replace(old_icon, new_icon, 1)

path.write_text(text)
