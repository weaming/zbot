/** 在隔离 hc 终端内验证实际 OSC 7501 字节流。 */
import { ProgramStatusReporter, isProgramStatusEnabled } from "../../../src/tui/program-status.js";

const reporter = new ProgramStatusReporter(isProgramStatusEnabled());
reporter.setTitle("中文状态测试");
reporter.sync(false);
reporter.session("session1", { state: "working" });
reporter.sync(true);
reporter.session("session1", { state: "done" });
reporter.sync(false);
reporter.sync(true);
reporter.sync(true, { kind: "question", msg: "等待测试输入" });
process.stdin.resume();
process.stdin.once("data", () => {
    reporter.release();
    process.exit(0);
});
