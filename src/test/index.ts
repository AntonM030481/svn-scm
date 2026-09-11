import * as path from "path";
import * as Mocha from "mocha";
import * as glob from "glob";

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "tdd",
    timeout: 30000,
    retries: 1,
    color: true
  });

  const testsRoot = path.resolve(__dirname, "..");

  return new Promise((resolve, reject) => {
    glob(
      "**/**.test.js",
      { cwd: testsRoot, ignore: ["test/globMatch.test.js"] },
      (err, files) => {
        if (err) {
          reject(err);
          return;
        }

        files.forEach(file =>
          mocha.addFile(path.resolve(testsRoot, file))
        );

        try {
          mocha.run(failures => {
            if (failures > 0) {
              reject(new Error(`${failures} tests failed.`));
            } else {
              resolve();
            }
          });
        } catch (error) {
          reject(error);
        }
      }
    );
  });
}
