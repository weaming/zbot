/** 在隔离 hc 终端内验证实际 OSC 7501 字节流与 hc label 上报清理。 */
import { HcReporter, readHcContext } from "../../../src/tui/hc-reporter.js";
import { ProgramStatusReporter, isProgramStatusEnabled } from "../../../src/tui/program-status.js";

const reporter = new ProgramStatusReporter(isProgramStatusEnabled());
const hcLabels = new HcReporter(readHcContext());
hcLabels.reportMetadata({
    title: "中文状态测试",
    tokens: {
        session: "GWKTPM37",
        tabs: "GWKTPM37,DC3RSX27",
        model: "deepseek-chat",
    },
});
reporter.setTitle("中文状态测试");
reporter.sync(true);
setTimeout(() => {
    reporter.session("session1", { state: "working" });
    reporter.session("session1", { state: "done" });
    reporter.sync(false);
    reporter.sync(true);
    reporter.sync(true, { kind: "question", msg: "等待测试输入" });
}, 150);
process.stdin.resume();
process.stdin.once("data", () => {
    hcLabels.release();
    reporter.release();
    process.exit(0);
});
