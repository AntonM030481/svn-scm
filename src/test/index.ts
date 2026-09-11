import * as path from "path";
import Mocha from "mocha";
import glob from "glob";

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
      (err: Error | null, files: string[]) => {
        if (err) {
          reject(err);
          return;
        }

        files.forEach((file: string) =>
          mocha.addFile(path.resolve(testsRoot, file))
        );

        try {
          mocha.run((failures: number) => {
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
