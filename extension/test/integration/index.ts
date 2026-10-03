import * as fs from "node:fs";
import * as path from "node:path";
import Mocha from "mocha";

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", timeout: 60_000, color: true });
  for (const f of fs.readdirSync(__dirname).sort()) {
    if (f.endsWith(".test.js")) {
      mocha.addFile(path.join(__dirname, f));
    }
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
