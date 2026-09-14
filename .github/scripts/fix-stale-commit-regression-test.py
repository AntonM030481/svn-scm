from pathlib import Path

p = Path('src/test/staging.test.ts')
s = p.read_text()
old = '''      repository.inputBox.value = "commit after external unstage";\n      await commands.executeCommand("svn.commit");\n      assert.equal(svn(["status"], checkout.fsPath).trim(), "");\n'''
new = '''      repository.inputBox.value = "commit after external unstage";\n      setTimeout(() => {\n        void commands.executeCommand(\n          "svn.forceCommitMessageTest",\n          "commit after external unstage"\n        );\n      }, 100);\n      await commands.executeCommand("svn.commit");\n      assert.equal(svn(["status"], checkout.fsPath).trim(), "");\n'''
if old not in s:
    raise SystemExit('stale commit regression block not found')
p.write_text(s.replace(old, new, 1))
