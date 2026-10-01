import * as path from "node:path";
import * as fs from "node:fs";
import Mocha from "mocha";

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", timeout: 120_000, color: true });
  const dir = __dirname;
  for (const f of fs.readdirSync(dir).sort()) {
    if (f.endsWith(".test.js")) {
      mocha.addFile(path.join(dir, f));
    }
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
