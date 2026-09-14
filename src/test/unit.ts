import * as path from "path";
import Mocha = require("mocha");

async function main(): Promise<void> {
  const mocha = new Mocha({
    ui: "tdd",
    timeout: 10000,
    color: true
  });

  mocha.addFile(path.resolve(__dirname, "statusSnapshot.test.js"));
  mocha.addFile(path.resolve(__dirname, "globMatch.test.js"));
  mocha.addFile(path.resolve(__dirname, "svnError.test.js"));
  mocha.addFile(path.resolve(__dirname, "svnProcess.test.js"));
  mocha.addFile(path.resolve(__dirname, "lifecycle.test.js"));
  mocha.addFile(path.resolve(__dirname, "commitMessageHtml.test.js"));
  mocha.addFile(path.resolve(__dirname, "stagingModel.test.js"));

  mocha.addFile(path.resolve(__dirname, "settingsDocumentation.test.js"));
  mocha.addFile(path.resolve(__dirname, "settingValues.test.js"));

  const failures = await new Promise<number>(resolve => {
    mocha.run(resolve);
  });

  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
