import { Readable } from "node:stream";
import { spec } from "node:test/reporters";

// Keep Node's failure diagnostics and final summary, without passing-test chatter.
export default async function* quiet(source) {
  async function* failuresAndSummary() {
    for await (const event of source) {
      if (event.type === "test:fail" || event.type === "test:summary" ||
          (event.type === "test:diagnostic" && event.data.nesting === 0 &&
            /^(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) [\d.]+$/.test(event.data.message))) yield event;
    }
  }
  yield* Readable.from(failuresAndSummary()).pipe(spec());
}
